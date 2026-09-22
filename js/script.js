class WordleGame {
    static KEYBOARD_LAYOUT = [
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACKSPACE"]
    ];

    static STATUS_PRIORITY = {
        absent: 1,
        present: 2,
        correct: 3,
    };

    static EMOJI_BY_STATUS = {
        correct: "🟩",
        present: "🟨",
        absent: "⬜",
    };

    static FLIP_DURATION = 500;
    static STAGGER_DELAY = 270;

    constructor(config) {
        this.todayWord = String(config.TODAY_WORD).trim().toUpperCase();
        this.wordLength = this.todayWord.length;
        this.maxAttempts = Number(config.MAX_ATTEMPTS);
        this.bypassWordLimit = Boolean(config.BYPASS_WORD_LIMIT);
        if (this.bypassWordLimit){
            WordleGame.KEYBOARD_LAYOUT.push(["SPACE"])
        }
        this.currentGuess = "";
        this.currentRow = 0;
        this.guesses = [];
        this.guessResults = [];
        this.words = new Map();

        this.gameEnded = false;
        this.isAnimating = false;
        this.won = false;
        this.messageTimeout = null;

        this.cookieName = `wordleGameState`;

        this.cacheElements();
        this.initializeGame();
    }

    cacheElements() {
        this.elements = {
            grid: document.getElementById("grid"),
            keyboard: document.getElementById("keyboard"),
            message: document.getElementById("message"),
            modal: document.getElementById("modal"),
            modalTitle: document.getElementById("modalTitle"),
            modalMessage: document.getElementById("modalMessage"),
            wordMeaning: document.getElementById("wordMeaning"),
            closeModal: document.getElementById("closeModal"),
            copyResults: document.getElementById("copyResults"),
        };
    }

    initializeGame() {
        this.createGrid();
        this.createKeyboard();
        this.setupEventListeners();
        this.restoreGameState();
        this.loadWords();
    }

    loadWords() {
        Papa.parse(`./assets/lists/dictionary.csv`, {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: ({ data }) => {
                this.words = new Map(
                    data
                        .map((row) => [
                            String(row.word ?? "").trim().toUpperCase(),
                            String(row.definition ?? "").trim(),
                        ])
                        .filter(([name]) => name.length > 0),
                );

                if (this.gameEnded) {
                    this.displayWordMeaning();
                }
            },

            error: (error) => {
                console.error("Could not load the word list:", error);
                this.showMessage("Could not load the word list.", "error");
            },
        });
    }

    createGrid() {
        const fragment = document.createDocumentFragment();
        this.tiles = [];
        this.elements.grid.dataset.wordLength = this.wordLength;

        for (let rowIndex = 0; rowIndex < this.maxAttempts; rowIndex++) {
            const row = document.createElement("div");
            const rowTiles = [];

            row.className = "row";
            for (
                let columnIndex = 0;
                columnIndex < this.wordLength;
                columnIndex++
            ) {
                const tile = document.createElement("div");

                tile.className = "tile";
                rowTiles.push(tile);
                row.appendChild(tile);
            }

            this.tiles.push(rowTiles);
            fragment.appendChild(row);
        }

        this.elements.grid.replaceChildren(fragment);
    }

    createKeyboard() {
        const fragment = document.createDocumentFragment();
        this.keyElements = new Map();
        for (const rowKeys of WordleGame.KEYBOARD_LAYOUT) {
            const keyboardRow = document.createElement("div");
            keyboardRow.className = "keyboard-row";

            for (const key of rowKeys) {
                const keyElement = document.createElement("button");

                keyElement.type = "button";
                keyElement.className = "key";
                keyElement.dataset.key = key;
                keyElement.textContent = key === "BACKSPACE" ? "⌫" : key;
                this.keyElements.set(key, keyElement)
                if (["BACKSPACE","ENTER"].includes(key)) {
                    keyElement.classList.add("wide");
                }
                if (key === "SPACE"){
                    keyElement.classList.add("space");
                }

                keyElement.addEventListener("click", (event) => {
                    event.preventDefault();
                    this.handleKeyPress(key);
                });

                keyElement.addEventListener("contextmenu", (event) => {
                    event.preventDefault();
                });

                keyboardRow.appendChild(keyElement);
            }

            fragment.appendChild(keyboardRow);
        }

        this.elements.keyboard.replaceChildren(fragment);
    }

    setupEventListeners() {
        document.addEventListener("keydown", (event) => {
            const key = event.key.toUpperCase();
            if (key === "ENTER" || key === "BACKSPACE") {
                this.handleKeyPress(key);
                return;
            }

            if (/^[A-Z]$/.test(key) || key === " ") {
                this.handleKeyPress(key);
            }
        });

        this.elements.closeModal.addEventListener("click", () => {
            this.hideModal();
        });

        this.elements.copyResults.addEventListener("click", () => {
            this.copyResults();
        });

        window.addEventListener("click", (event) => {
            if (event.target === this.elements.modal) {
                this.hideModal();
            }
        });
    }

    handleKeyPress(key) {
        if (this.gameEnded || this.isAnimating) {
            return;
        }

        switch (key) {
            case "ENTER":
                this.submitGuess();
                break;

            case "BACKSPACE":
                this.deleteLetter();
                break;
            case "SPACE":
                this.addLetter(" ");
                break;
            default:
                this.addLetter(key);
        }
    }

    addLetter(letter) {
        if (this.currentGuess.length >= this.wordLength) {
            return;
        }

        this.currentGuess += letter;
        this.updateDisplay();
    }

    deleteLetter() {
        if (this.currentGuess.length === 0) {
            return;
        }

        this.currentGuess = this.currentGuess.slice(0, -1);
        this.updateDisplay();
    }

    updateDisplay() {
        const currentRowTiles = this.tiles[this.currentRow];

        for (let index = 0; index < this.wordLength; index++) {
            const tile = currentRowTiles[index];
            const letter = this.currentGuess[index] ?? "";

            tile.textContent = letter;
            tile.classList.toggle("filled", letter !== "");
        }
    }

    async submitGuess() {
        if (this.currentGuess.length !== this.wordLength) {
            this.showMessage("Not enough letters.", "error");
            return
        }
        const guess = this.currentGuess;
        const won = guess === this.todayWord;

        if (!(this.words.has(guess.trim())) && !won) {
            this.showMessage("Not a valid word.", "error");
            return;
        }

        this.guesses.push(guess);
        await this.revealGuess(guess);

        if (won) {
            await this.endGame(true);
            return;
        }

        if (this.guesses.length >= this.maxAttempts) {
            await this.endGame(false);
            return;
        }

        this.currentRow++;
        this.currentGuess = "";
        this.saveGameState();
    }

    evaluateGuess(guess) {
        const result = Array(this.wordLength).fill("absent");
        const remainingCounts = Object.create(null);

        // First pass: exact matches and counts of unmatched target letters.
        for (let index = 0; index < this.wordLength; index++) {
            if (guess[index] === this.todayWord[index]) {
                result[index] = "correct";
            } else {
                const targetLetter = this.todayWord[index];
                remainingCounts[targetLetter] =
                    (remainingCounts[targetLetter] ?? 0) + 1;
            }
        }

        // Second pass: letters that exist elsewhere in the target.
        for (let index = 0; index < this.wordLength; index++) {
            if (result[index] === "correct") {
                continue;
            }

            const guessedLetter = guess[index];

            if ((remainingCounts[guessedLetter] ?? 0) > 0) {
                result[index] = "present";
                remainingCounts[guessedLetter]--;
            }
        }

        return result;
    }

    revealGuess(guess) {
        const result = this.evaluateGuess(guess);
        const rowTiles = this.tiles[this.currentRow];

        this.guessResults.push(result);
        this.isAnimating = true;

        for (let index = 0; index < this.wordLength; index++) {
            const tile = rowTiles[index];
            const delay = index * WordleGame.STAGGER_DELAY;

            setTimeout(() => {
                tile.classList.add("flip");
            }, delay);

            setTimeout(() => {
                tile.classList.add(result[index]);
            }, delay + WordleGame.FLIP_DURATION / 2);

            setTimeout(() => {
                this.updateKeyboard(guess[index], result[index]);
            }, delay + WordleGame.FLIP_DURATION);
        }

        const totalDuration =
            (this.wordLength - 1) * WordleGame.STAGGER_DELAY
            + WordleGame.FLIP_DURATION;

        return new Promise((resolve) => {
            setTimeout(() => {
                this.isAnimating = false;
                resolve();
            }, totalDuration);
        });
    }

    updateKeyboard(letter, newStatus) {
        const key = this.keyElements.get(letter);
        if (!key) {
            return;
        }

        const currentStatus = key.dataset.status;


        const currentPriority =
            WordleGame.STATUS_PRIORITY[currentStatus] ?? 0;
        const newPriority = WordleGame.STATUS_PRIORITY[newStatus];

        if (newPriority <= currentPriority) {
            return;
        }

        if (currentStatus) {
            key.classList.remove(currentStatus);
        }

        key.classList.add(newStatus);
        key.dataset.status = newStatus;
    }

    async endGame(won) {
        this.gameEnded = true;
        this.won = won;

        if (won) {
            this.elements.modalTitle.textContent = "Congratulations! 🎉";
            this.elements.modalMessage.textContent =
                `You guessed the word in ${this.guesses.length} tries!`;
        } else {
            this.elements.modalTitle.textContent = "Game Over 😞";
            this.elements.modalMessage.textContent =
                `The word was: ${this.todayWord}`;
        }

        this.saveGameState();
        this.showModal();
        await this.displayWordMeaning();
    }

    async displayWordMeaning() {
        this.elements.wordMeaning.innerHTML = '<div class="loading"></div>';

        let localDescription = this.words.get(this.todayWord);
        if (!localDescription){
            localDescription = "No definition yet for this word. :("
        }
            this.elements.wordMeaning.replaceChildren(
                this.createDefinitionElement(localDescription),
            );
    }

    createDefinitionElement(definition) {
        const container = document.createElement("div");
        const definitionText = document.createElement("div");

        container.className = "definition";
        definitionText.className = "definition-text";
        definitionText.textContent = definition;
        container.appendChild(definitionText);

        return container;
    }

    async copyResults() {
        const emojiGrid = this.guessResults
            .map((row) =>
                row
                    .map((status) => WordleGame.EMOJI_BY_STATUS[status])
                    .join(""),
            )
            .join("\n");

        let heading = `Wordle guessed in ${this.guesses.length}/${this.maxAttempts}!`;
        if (!this.won){
            heading = `Wordle attempted! ${this.guesses.length}/${this.maxAttempts}!`
        }

        const resultText = [heading, "", emojiGrid].join("\n");

        try {
            await navigator.clipboard.writeText(resultText);
            this.showMessage("Results copied!", "success");
        } catch (error) {
            console.error("Clipboard error:", error);
            this.showMessage("Could not copy results.", "error");
        }
    }

    getNextMidnight() {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        return midnight;
    }

    setCookie(name, value) {
        const expires = this.getNextMidnight().toUTCString();
        const secure = location.protocol === "https:" ? "; Secure" : "";

        document.cookie =
            `${encodeURIComponent(name)}=${encodeURIComponent(value)}; ` +
            `expires=${expires}; path=/; SameSite=Lax${secure}`;
    }

    getCookie(name) {
        const prefix = `${encodeURIComponent(name)}=`;

        for (const cookie of document.cookie.split(";")) {
            const trimmedCookie = cookie.trim();

            if (trimmedCookie.startsWith(prefix)) {
                return decodeURIComponent(trimmedCookie.slice(prefix.length));
            }
        }

        return null;
    }

    deleteCookie(name) {
        document.cookie =
            `${encodeURIComponent(name)}=; ` +
            "expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax";
    }

    saveGameState() {
        const state = {
            word: this.todayWord,
            wordLength: this.wordLength,
            maxAttempts: this.maxAttempts,
            guesses: this.guesses,
            guessResults: this.guessResults,
            gameEnded: this.gameEnded,
            won: this.won,
        };

        this.setCookie(this.cookieName, JSON.stringify(state));
    }

    restoreGameState() {
        const savedCookie = this.getCookie(this.cookieName);

        if (!savedCookie) {
            return;
        }

        let state;

        try {
            state = JSON.parse(savedCookie);
        } catch (error) {
            console.warn("Invalid saved game cookie:", error);
            this.deleteCookie(this.cookieName);
            return;
        }

        if (
            state.word !== this.todayWord
            || state.wordLength !== this.wordLength
            || state.maxAttempts !== this.maxAttempts
            || !Array.isArray(state.guesses)
            || !Array.isArray(state.guessResults)
        ) {
            this.deleteCookie(this.cookieName);
            return;
        }

        this.guesses = state.guesses.slice(0, this.maxAttempts);
        this.guessResults = state.guessResults.slice(0, this.maxAttempts);
        this.gameEnded = Boolean(state.gameEnded);
        this.won = Boolean(state.won);
        this.currentGuess = "";

        this.renderSavedGuesses();

        if (this.gameEnded) {
            this.currentRow = Math.max(0, this.guesses.length - 1);

            if (this.won) {
                this.elements.modalTitle.textContent = "Congratulations! 🎉";
                this.elements.modalMessage.textContent =
                    `You guessed the word in ${this.guesses.length} tries!`;
            } else {
                this.elements.modalTitle.textContent = "Game Over 😞";
                this.elements.modalMessage.textContent =
                    `The word was: ${this.todayWord}`;
            }

            this.showModal();
        } else {
            this.currentRow = Math.min(
                this.guesses.length,
                this.maxAttempts - 1,
            );
        }
    }

    renderSavedGuesses() {
        for (let rowIndex = 0; rowIndex < this.guesses.length; rowIndex++) {
            const guess = this.guesses[rowIndex];
            const result = this.guessResults[rowIndex];
            const rowTiles = this.tiles[rowIndex];

            if (
                typeof guess !== "string"
                || !Array.isArray(result)
                || !rowTiles
            ) {
                continue;
            }

            for (
                let columnIndex = 0;
                columnIndex < this.wordLength;
                columnIndex++
            ) {
                const letter = guess[columnIndex] ?? "";
                const status = result[columnIndex];
                const tile = rowTiles[columnIndex];

                tile.textContent = letter;
                tile.classList.toggle("filled", letter !== "");

                if (WordleGame.STATUS_PRIORITY[status]) {
                    tile.classList.add(status);
                    this.updateKeyboard(letter, status);
                }
            }
        }
    }

    showMessage(text, type = "") {
        clearTimeout(this.messageTimeout);

        this.elements.message.hidden = false;
        this.elements.message.textContent = text;
        this.elements.message.className = `message ${type}`.trim();

        this.messageTimeout = setTimeout(() => {
            this.elements.message.textContent = "";
            this.elements.message.className = "message";
            this.elements.message.hidden = true;
        }, 3000);
    }

    showModal() {
        this.elements.modal.style.display = "block";
    }

    hideModal() {
        this.elements.modal.style.display = "none";
    }
}

const CONFIG_URL =
    "https://gist.githubusercontent.com/jltwiao/ec0ed2f1aeb966f5f78ffab13a3e2959/raw/bible-wordle.json";

async function loadWordleConfig() {
    const time = new Date().setMinutes(0, 0, 0);
    const response = await fetch(`${CONFIG_URL}?t=${time}`);

    if (!response.ok) {
        throw new Error(
            `Could not load Wordle configuration: ${response.status}`
        );
    }

    const config = await response.json();

    if (!config.TODAY_WORD) {
        throw new Error("The Gist does not contain TODAY_WORD.");
    }

    if (!Number.isInteger(Number(config.MAX_ATTEMPTS))) {
        throw new Error("The Gist contains an invalid MAX_ATTEMPTS.");
    }

    return config;
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const config = await loadWordleConfig();
        new WordleGame(config);
    } catch (error) {
        console.error("Could not start Wordle:", error);

        const message = document.getElementById("message");

        if (message) {
            message.hidden = false;
            message.className = "message error";
            message.textContent = "Could not load today's Wordle.";
        }
    }
});
