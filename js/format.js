'use strict';

// Date keys use the browser's local calendar day, not UTC.
function localDay(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const validPoints = n => Number.isSafeInteger(n) && n >= 0;
const signed = n => `${n >= 0 ? '+' : ''}${n}`;
function validDay(day) {
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}

// Higher scores win; equal scores favor the player who reached that total first.
function ranksFor(players) {
    const sorted = [...players].sort((a, b) =>
        b.points - a.points || a.reachedOrder - b.reachedOrder
    );
    return new Map(sorted.map((player, index) => [player.id, index + 1]));
}

// A persistent sequence also distinguishes score edits within the same millisecond.
function nextReachedOrder(data) {
    return Math.max(-1, ...data.players.map(p => p.initialOrder),
        ...data.events.map(e => e.reachedOrder)) + 1;
}

// Rebuild opening and closing standings from one net total per player per day.
function dailySnapshot(data, day) {
    const eligible = data.players.filter(p => p.createdDay <= day);
    const opening = [], closing = [];
    for (const player of eligible) {
        let start = player.initialPoints, end = player.initialPoints;
        let startOrder = player.initialOrder, endOrder = player.initialOrder;
        for (const event of data.events) {
            if (event.playerId !== player.id) continue;
            if (event.day < day) { start += event.delta; startOrder = event.reachedOrder; }
            if (event.day <= day) { end += event.delta; endOrder = event.reachedOrder; }
        }
        if (player.baseline || player.createdDay < day) opening.push({ id: player.id, points: start, reachedOrder: startOrder });
        closing.push({ ...player, start, points: end, gain: end - start, reachedOrder: endOrder });
    }
    const before = ranksFor(opening), after = ranksFor(closing);
    return closing.map(p => {
        const oldRank = before.get(p.id), rank = after.get(p.id);
        const change = oldRank === undefined ? 'NEW' : rank < oldRank ? '↑' : rank > oldRank ? '↓' : '-';
        return { ...p, oldRank, rank, change };
    });
}

function validateData(data) {
    if (!data || data.version !== 2 || !validDay(data.startedDay) || !Array.isArray(data.players) || !Array.isArray(data.events)) return false;
    const ids = new Set(), totals = new Map(), eventIds = new Set();
    for (const p of data.players) {
        if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string' ||
            (p.initialOrder !== undefined && !validPoints(p.initialOrder)) ||
            !validPoints(p.initialPoints) || !validPoints(p.points) || !validDay(p.createdDay) ||
            p.createdDay < data.startedDay || typeof p.baseline !== 'boolean' ||
            (p.baseline && p.createdDay !== data.startedDay)) return false;
        ids.add(p.id); totals.set(p.id, p.initialPoints);
    }
    let previousDay = data.startedDay;
    for (const e of data.events) {
        const player = data.players.find(p => p.id === e?.playerId);
        if (!e || typeof e.id !== 'string' || !e.id || eventIds.has(e.id) || !player ||
            !validDay(e.day) || e.day < previousDay || e.day < player.createdDay ||
            typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at)) || typeof e.name !== 'string' ||
            (e.reachedOrder !== undefined && !validPoints(e.reachedOrder)) ||
            !Number.isSafeInteger(e.delta) || !validPoints(e.before) || !validPoints(e.after) ||
            e.before !== totals.get(e.playerId) || e.after - e.before !== e.delta) return false;
        previousDay = e.day; eventIds.add(e.id); totals.set(e.playerId, e.after);
    }
    return data.players.every(p => p.points === totals.get(p.id));
}


// The existing "events" field is retained for backup compatibility, but now
// holds only ONE daily total per player. Older detailed logs are consolidated.
function consolidateDailyChanges(data) {
    const next = structuredClone(data);
    const grouped = new Map();
    for (const entry of next.events) {
        const key = JSON.stringify([entry.day, entry.playerId]);
        const daily = grouped.get(key);
        if (daily) {
            daily.after = entry.after;
            daily.delta = daily.after - daily.before;
            daily.at = entry.at;
            daily.name = entry.name;
            daily.reachedOrder = entry.reachedOrder;
        } else {
            grouped.set(key, { ...entry });
        }
    }
    next.events = [...grouped.values()];
    const orders = [...next.players.map(p => p.initialOrder), ...next.events.map(e => e.reachedOrder)];
    if (orders.some(order => order === undefined) || new Set(orders).size !== orders.length) {
        // Older backups know the last update time for each daily total.
        // Initial totals have no exact timing, so preserve their existing row order.
        const timeline = [
            ...next.players.map(p => ({ day: p.createdDay, time: -Infinity, item: p, field: 'initialOrder' })),
            ...next.events.map(e => ({ day: e.day, time: Date.parse(e.at), item: e, field: 'reachedOrder' }))
        ];
        timeline.sort((a, b) => a.day.localeCompare(b.day) || a.time - b.time);
        timeline.forEach((entry, index) => { entry.item[entry.field] = index; });
    }
    return next;
}

class Table {
    constructor() {
        // Keep the old key untouched so migration has a fallback copy.
        this.storageKey = 'scores_data_v2';
        this.table = document.getElementById('tableData');
        this.message = document.getElementById('message');
        this.data = this.getSavedTable();
        this.renderedDay = localDay();
        document.getElementById('historyDate').value = this.renderedDay;
        document.getElementById('historyDate').min = this.data.startedDay;
        if (!this.data.players.length && !this.savingDisabled) this.addRow();
        else this.loadSavedTable();
        document.getElementById('addRow').addEventListener('click', () => {
            if (this.addRow()) this.table.lastElementChild.querySelector('input').focus();
        });
        document.getElementById('sortTable').addEventListener('click', () => this.sortTable());
        document.getElementById('copyTable').addEventListener('click', () => this.copyTable());
        document.getElementById('historyDate').addEventListener('change', () => this.renderHistory());
        document.getElementById('exportData').addEventListener('click', () => this.exportData());
        document.getElementById('importData').addEventListener('change', e => this.importData(e));
        // Refresh daily gains if the page stays open over midnight.
        setInterval(() => this.refreshDay(), 30000);
        window.addEventListener('focus', () => this.refreshDay());
        window.addEventListener('storage', event => {
            if (event.key === this.storageKey || event.key === null) {
                this.savingDisabled = true;
                this.showMessage('Scores changed in another tab. Reload this page before editing to avoid overwriting them.', true);
            }
        });
    }

    get tableData() { return this.data.players; }

    getSavedTable() {
        const empty = { version: 2, startedDay: localDay(), players: [], events: [] };
        try {
            this.lastSaved = localStorage.getItem(this.storageKey);
            if (this.lastSaved !== null) {
                const data = JSON.parse(this.lastSaved);
                if (!validateData(data)) throw new Error('Invalid saved history');
                const dailyData = consolidateDailyChanges(data);
                const serialized = JSON.stringify(dailyData);
                if (serialized !== this.lastSaved) localStorage.setItem(this.storageKey, serialized);
                this.lastSaved = serialized;
                return dailyData;
            }
            const legacy = localStorage.getItem('scores_data');
            if (legacy === null) return empty;
            const rows = JSON.parse(legacy);
            if (!Array.isArray(rows) || !rows.every(r => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && validPoints(r[1]))) throw new Error('Invalid legacy scores');
            empty.players = rows.map(([name, points], index) => ({
                id: newId(), name, points, initialOrder: index, initialPoints: points, createdDay: empty.startedDay, baseline: true
            }));
            // Migration records current totals, never invented historical gains.
            const serialized = JSON.stringify(empty);
            localStorage.setItem(this.storageKey, serialized);
            this.lastSaved = serialized;
            return empty;
        } catch (error) {
            this.savingDisabled = true;
            console.error(error);
            this.showMessage('Saved scores could not be read or migrated. Editing is disabled to protect existing data. Restore a valid backup or reload after allowing browser storage.', true);
            return empty;
        }
    }

    canEdit() {
        if (this.savingDisabled) {
            this.showMessage('Editing is disabled. Reload the page or restore a valid backup.', true);
            return false;
        }
        try {
            if (localStorage.getItem(this.storageKey) !== this.lastSaved) {
                this.savingDisabled = true;
                this.showMessage('Scores changed in another tab. Reload before editing.', true);
                return false;
            }
        } catch { this.showMessage('Browser storage is unavailable. Changes cannot be saved.', true); return false; }
        const lastDay = [this.data.startedDay, ...this.data.players.map(p => p.createdDay), ...this.data.events.map(e => e.day)].sort().at(-1);
        if (localDay() < lastDay) {
            this.showMessage('The saved history includes a later date. Check your device date before making changes.', true);
            return false;
        }
        return true;
    }

    // Persist first; if storage fails the existing table and history stay intact.
    commit(next) {
        try {
            const serialized = JSON.stringify(next);
            localStorage.setItem(this.storageKey, serialized);
            this.lastSaved = serialized;
            this.data = next;
            this.showMessage('Saved in this browser.');
            return true;
        } catch (error) {
            console.error(error);
            this.showMessage('Could not save. This change was not applied. Export a backup and check browser storage.', true);
            return false;
        }
    }

    addRow() {
        if (!this.canEdit()) return false;
        const next = structuredClone(this.data);
        next.players.push({ id: newId(), name: '', points: 0, initialOrder: nextReachedOrder(next), initialPoints: 0, createdDay: localDay(), baseline: false });
        if (!this.commit(next)) return false;
        this.loadSavedTable();
        return true;
    }

    sortTable() {
        if (!this.canEdit()) return;
        const next = structuredClone(this.data);
        const ranks = new Map(dailySnapshot(next, localDay()).map(p => [p.id, p.rank]));
        next.players.sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
        if (this.commit(next)) this.loadSavedTable();
    }

    updatePoints(id, points) {
        if (!validPoints(points) || !this.canEdit()) return false;
        const player = this.tableData.find(p => p.id === id);
        if (player.points === points) return true;
        const next = structuredClone(this.data);
        const target = next.players.find(p => p.id === id);
        const now = new Date();
        const day = localDay(now);
        const reachedOrder = nextReachedOrder(next);
        const daily = next.events.find(entry => entry.playerId === id && entry.day === day);
        if (daily) {
            daily.after = points;
            daily.delta = points - daily.before;
            daily.at = now.toISOString();
            daily.name = player.name || '(unnamed)';
            daily.reachedOrder = reachedOrder;
        } else {
            next.events.push({ id: newId(), playerId: id, name: player.name || '(unnamed)',
                day, reachedOrder, at: now.toISOString(), before: player.points, after: points, delta: points - player.points });
        }
        target.points = points;
        if (!this.commit(next)) return false;
        // Do not replace inputs during blur: the following +/− click must still fire.
        this.updateStats();
        return true;
    }

    loadSavedTable() {
        this.table.replaceChildren();
        this.tableData.forEach(p => this.createRow(p));
        this.updateStats();
    }

    createRow(player) {
        const row = document.createElement('tr');
        row.className = 'rowData'; row.dataset.playerId = player.id;
        const rank = document.createElement('td'); rank.className = 'rank';
        const nameCell = document.createElement('td');
        const name = document.createElement('input'); name.type = 'text'; name.value = player.name;
        name.placeholder = 'Player name'; name.setAttribute('aria-label', 'Player name');
        name.addEventListener('change', () => {
            if (!this.canEdit()) { name.value = this.tableData.find(p => p.id === player.id).name; return; }
            const next = structuredClone(this.data);
            next.players.find(p => p.id === player.id).name = name.value;
            if (this.commit(next)) this.updateStats();
            else name.value = this.tableData.find(p => p.id === player.id).name;
        });
        name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });
        nameCell.append(name);
        const pointsCell = document.createElement('td');
        const points = document.createElement('input');
        points.className = 'points-input'; points.type = 'number'; points.step = '1'; points.min = '0';
        points.max = String(Number.MAX_SAFE_INTEGER); points.value = player.points;
        points.setAttribute('aria-label', 'Total points');
        points.addEventListener('change', () => {
            const value = points.valueAsNumber;
            if (!validPoints(value)) this.showMessage('Points must be a whole number of zero or more.', true);
            else this.updatePoints(player.id, value);
            points.value = this.tableData.find(p => p.id === player.id).points;
        });
        points.addEventListener('keydown', e => { if (e.key === 'Enter') points.blur(); });
        pointsCell.append(points);
        const gain = document.createElement('td'); gain.className = 'gain';
        const change = document.createElement('td'); change.className = 'movement';
        const controls = document.createElement('td'); controls.className = 'add_remove';
        for (const [label, amount, className] of [['+', 1, 'add-point'], ['−', -1, 'remove-point']]) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = className;
            button.setAttribute('aria-label', amount > 0 ? 'Add one point' : 'Remove one point');
            button.addEventListener('click', () => {
                const current = this.tableData.find(p => p.id === player.id).points;
                this.updatePoints(player.id, Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, current + amount)));
                points.value = this.tableData.find(p => p.id === player.id).points;
            });
            controls.append(button);
        }
        row.append(rank, nameCell, pointsCell, gain, change, controls);
        this.table.append(row);
    }

    refreshDay() {
        if (this.renderedDay !== localDay()) {
            const field = document.getElementById('historyDate');
            if (field.value === this.renderedDay) field.value = localDay();
            this.renderedDay = localDay();
            this.updateStats();
        }
    }

    updateStats() {
        const today = localDay();
        const stats = new Map(dailySnapshot(this.data, today).map(p => [p.id, p]));
        document.getElementById('dayInfo').textContent = `Today: ${today} · Gains and movement are measured from the start of this local calendar day.`;
        for (const row of this.table.children) {
            const p = stats.get(row.dataset.playerId);
            if (!p) continue;
            row.querySelector('.rank').textContent = p.rank;
            row.querySelector('.gain').textContent = signed(p.gain);
            const movement = row.querySelector('.movement'); movement.textContent = p.change;
            movement.className = `movement ${p.change === '↑' ? 'up' : p.change === '↓' ? 'down' : ''}`;
            movement.title = p.oldRank === undefined ? 'New player today' : `Start rank ${p.oldRank} → current rank ${p.rank}`;
            row.querySelector('.remove-point').disabled = p.points === 0;
            row.querySelector('.add-point').disabled = p.points === Number.MAX_SAFE_INTEGER;
        }
        document.getElementById('historyDate').max = today;
        this.renderHistory();
    }

    appendCells(body, values) {
        const row = document.createElement('tr');
        values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
        body.append(row);
    }

    renderHistory() {
        const day = document.getElementById('historyDate').value;
        const daily = document.getElementById('dailyHistory');
        daily.replaceChildren();
        if (!validDay(day) || day < this.data.startedDay || day > localDay()) {
            this.appendCells(daily, ['Choose a date from the recorded period.']); return;
        }
        const snapshot = dailySnapshot(this.data, day).sort((a, b) => a.rank - b.rank);
        snapshot.forEach(p => this.appendCells(daily, [p.name || '(unnamed)', p.start, p.points, signed(p.gain), `${p.oldRank ?? 'NEW'} → ${p.rank}`, p.change]));

    }

    tableText() {
        const rows = dailySnapshot(this.data, localDay()).sort((a, b) => a.rank - b.rank);
        const cells = [['Rank', 'Name', 'PTs', 'Gain', 'CHG'], ...rows.map(p => [String(p.rank),
            (p.name || '(unnamed)').replace(/[\r\n\t|`]/g, ' '), String(p.points), `(${signed(p.gain)})`, `[${p.change}]`])];
        const widths = cells[0].map((_, i) => Math.max(...cells.map(row => row[i].length)));
        return '```\n' + cells.map(row => row.map((value, i) => value.padEnd(widths[i])).join(' | ').trimEnd()).join('\n') + '\n```';
    }

    async copyTable() {
        const text = this.tableText();
        try {
            await navigator.clipboard.writeText(text);
            document.getElementById('copyFallback').hidden = true;
            this.showMessage('Sorted leaderboard copied, including today’s gain and rank movement.');
        } catch {
            document.getElementById('copyFallback').hidden = false;
            const output = document.getElementById('copyOutput'); output.value = text; output.focus(); output.select();
            this.showMessage('Clipboard access is unavailable. Press Ctrl+C or Cmd+C to copy the selected table.', true);
        }
    }

    exportData() {
        const url = URL.createObjectURL(new Blob([JSON.stringify(this.data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `scores-history-${localDay()}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async importData(event) {
        const file = event.target.files[0]; if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!validateData(data)) throw new Error('This file is not a valid score-history backup.');
            if (!confirm('Replace the current scores and all history with this backup?')) return;
            if (this.commit(consolidateDailyChanges(data))) {
                this.savingDisabled = false;
                document.getElementById('historyDate').min = data.startedDay;
                document.getElementById('historyDate').value = localDay();
                this.loadSavedTable();
            }
        } catch (error) { this.showMessage(error.message || 'Could not restore this backup.', true); }
        finally { event.target.value = ''; }
    }

    showMessage(text, isError = false) {
        if (!this.message) return;
        this.message.hidden = false;
        this.message.className = isError ? 'message error' : 'message';
        this.message.textContent = text;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    try { new Table(); }
    catch (error) {
        console.error('Error loading table:', error);
        const message = document.getElementById('message');
        if (message) { message.hidden = false; message.className = 'message error'; message.textContent = 'Could not load the table.'; }
    }
});
