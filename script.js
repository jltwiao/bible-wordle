class WordleGame {
    static KEYBOARD_LAYOUT = [
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACKSPACE"],
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

    constructor() {
        this.currentWord = String(window.env.TODAY_WORD).trim().toUpperCase();
        this.wordLength = this.currentWord.length;
        this.maxAttempts = Number(window.env.MAX_ATTEMPTS);

        this.currentGuess = "";
        this.currentRow = 0;
        this.guesses = [];
        this.guessResults = [];
        this.words = new Map();

        this.gameEnded = false;
        this.isAnimating = false;
        this.won = false;
        this.messageTimeout = null;

        this.cookieName = `wordleGameState_${this.wordLength}`;

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
        Papa.parse(`./lists/words_${this.wordLength}.csv`, {
            download: true,
            header: true,
            skipEmptyLines: true,

            complete: ({ data }) => {
                this.words = new Map(
                    data
                        .map((row) => [
                            String(row.Name ?? "").trim().toUpperCase(),
                            String(row.Description ?? "").trim(),
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

        this.elements.grid.style.gridTemplateRows =
            `repeat(${this.maxAttempts}, 1fr)`;

        for (let rowIndex = 0; rowIndex < this.maxAttempts; rowIndex++) {
            const row = document.createElement("div");
            const rowTiles = [];

            row.className = "row";
            row.style.gridTemplateColumns =
                `repeat(${this.wordLength}, auto)`;

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

        for (const rowKeys of WordleGame.KEYBOARD_LAYOUT) {
            const keyboardRow = document.createElement("div");
            keyboardRow.className = "keyboard-row";

            for (const key of rowKeys) {
                const keyElement = document.createElement("button");

                keyElement.type = "button";
                keyElement.className = "key";
                keyElement.dataset.key = key;
                keyElement.textContent = key === "BACKSPACE" ? "⌫" : key;

                if (key === "ENTER" || key === "BACKSPACE") {
                    keyElement.classList.add("wide");
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

            if (/^[A-Z]$/.test(key)) {
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
            return;
        }


        const guess = this.currentGuess;
        const won = guess === this.currentWord;

        if (!(this.words.has(this.currentGuess)) && !won) {
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
            if (guess[index] === this.currentWord[index]) {
                result[index] = "correct";
            } else {
                const targetLetter = this.currentWord[index];
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
        const key = this.elements.keyboard.querySelector(
            `[data-key="${letter}"]`,
        );

        if (!key) {
            return;
        }

        const currentStatus = ["correct", "present", "absent"].find((status) =>
            key.classList.contains(status),
        );

        const currentPriority =
            WordleGame.STATUS_PRIORITY[currentStatus] ?? 0;
        const newPriority = WordleGame.STATUS_PRIORITY[newStatus];

        if (newPriority <= currentPriority) {
            return;
        }

        key.classList.remove("correct", "present", "absent");
        key.classList.add(newStatus);
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
                `The word was: ${this.currentWord}`;
        }

        this.saveGameState();
        this.showModal();
        await this.displayWordMeaning();
    }

    async displayWordMeaning() {
        this.elements.wordMeaning.innerHTML = '<div class="loading"></div>';

        let localDescription = this.words.get(this.currentWord);
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
            word: this.currentWord,
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
            state.word !== this.currentWord
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
                    `The word was: ${this.currentWord}`;
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

document.addEventListener("DOMContentLoaded", () => {
    new WordleGame();
});
