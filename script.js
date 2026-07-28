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

        if (!(await this.isValidWord(this.currentGuess))) {
            this.showMessage("Not a valid word.", "error");
            return;
        }

        const guess = this.currentGuess;
        const won = guess === this.currentWord;

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

    async isValidWord(word) {
        if (this.words.has(word)) {
            return true;
        }

        try {
            const response = await fetch(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`,
            );

            return response.ok;
        } catch (error) {
            console.error("Could not validate word:", error);
            return false;
        }
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

        this.showModal();
        await this.displayWordMeaning();
    }

    async displayWordMeaning() {
        this.elements.wordMeaning.innerHTML = '<div class="loading"></div>';

        const localDescription = this.words.get(this.currentWord);

        if (localDescription) {
            this.elements.wordMeaning.replaceChildren(
                this.createDefinitionElement(localDescription),
            );
            return;
        }

        try {
            const response = await fetch(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${this.currentWord.toLowerCase()}`,
            );

            if (!response.ok) {
                throw new Error(`Dictionary request failed: ${response.status}`);
            }

            const [wordData] = await response.json();
            const definitions = [];

            for (const meaning of wordData?.meanings ?? []) {
                const firstDefinition = meaning.definitions?.[0];

                if (!firstDefinition?.definition) {
                    continue;
                }

                definitions.push(
                    this.createDefinitionElement(
                        firstDefinition.definition,
                        firstDefinition.example,
                    ),
                );

                if (definitions.length === 3) {
                    break;
                }
            }

            if (definitions.length > 0) {
                this.elements.wordMeaning.replaceChildren(...definitions);
                return;
            }
        } catch (error) {
            console.error("Could not load word meaning:", error);
        }

        this.elements.wordMeaning.replaceChildren(
            this.createDefinitionElement(
                "Definition not available for this word.",
            ),
        );
    }

    createDefinitionElement(definition, example = "") {
        const container = document.createElement("div");
        const definitionText = document.createElement("div");

        container.className = "definition";
        definitionText.className = "definition-text";
        definitionText.textContent = definition;
        container.appendChild(definitionText);

        if (example) {
            const exampleText = document.createElement("div");

            exampleText.className = "example";
            exampleText.textContent = `Example: "${example}"`;
            container.appendChild(exampleText);
        }

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

        const heading = this.won
            ? `Wordle guessed in ${this.guesses.length}/${this.maxAttempts}!`
            : `Wordle X/${this.maxAttempts}`;

        const resultText = [heading, "", emojiGrid].join("\n");

        try {
            await navigator.clipboard.writeText(resultText);
            this.showMessage("Results copied!", "success");
        } catch (error) {
            console.error("Clipboard error:", error);
            this.showMessage("Could not copy results.", "error");
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
