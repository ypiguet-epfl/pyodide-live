/*

Integration of Pyodide, ACE editors for Python source code and output, and
graphics in the browser. Pyodide runs in a webworker.

Author: Yves Piguet, EPFL, 2020

Usage:

HTML:

<div id="src-editor">
(initial source code if any)
</div>
<div id="output-editor">
(initial output if any)
</div>

JS:

const options = {
    srcEditorId: "src-editor",
    srcTheme: "ace/theme/chrome",   // optional
    outputEditorId: "output-editor",
    outputTheme: "ace/theme/chrome",    // optional
    onTerminated: () => {}, // optional (called when code execution is done)
    onChangeStatus: (status) => {},    // optional
    figureId: "fig",    // optional (default: no graphical output)
    onChangeFigure: () => {},   // optional
    onFile: (path, data) => {}, // optional
    debugger: true, // optional (default: false)
    onSwitchDebugger: (debug) => {},    // optional (show/hide dbg buttons)
};
const pui = new PyodideUI(options);

*/

class PyodideUI {
    constructor(options) {
        this.pyWorker = new PyWorker("pyodide-webworker.js");
        this.dirtyFiles = [];
        this.dbgCurrentLine = null;
        this.pyWorker.timeout = 60
        this.onTerminated = options.onTerminated || null;
        this.onChangeStatus = options.onChangeStatus || null;
        this.figure = null;
        if (options.figureId) {
            this.figure = document.getElementById("figure");
        }
        this.inputStart = null;

        this.srcEditor = ace.edit(options.srcEditorId);
        this.srcEditor.setTheme(options.srcTheme || "ace/theme/chrome");
        this.srcEditor.session.setMode("ace/mode/python");
        this.debugger = options.debugger || false;

        if (this.debugger) {
            // breakpoints
            this.srcEditor.on("guttermousedown", (e) => {
                let target = e.domEvent.target;
                if (target.className.indexOf("ace_gutter-cell") != -1 &&
                    e.clientX <= 25 + target.getBoundingClientRect().left &&
                    !e.editor.getReadOnly()) {
                    const row = e.getDocumentPosition().row;
                    const breakpoints = e.editor.session.getBreakpoints(row, 0);
                    if (breakpoints[row] === undefined) {
                        e.editor.session.setBreakpoint(row);
                    } else {
                        e.editor.session.clearBreakpoint(row);
                    }
                    e.stop();
                }
            });
        }

        this.outputEditorId = options.outputEditorId;
        this.outputEditor = ace.edit(options.outputEditorId, {
            mode: "ace/mode/text",
            theme: options.outputTheme || "ace/theme/chrome",
            readOnly: true
        });

        this.pyWorker.onError = (event) => {
            this.outputEditor.gotoLine(1e9);
            this.outputEditor.insert(event.message);
        };

        this.pyWorker.onStatusChanged = (status) => {
            this.changeStatus(status || (this.pyWorker.isSuspended ? "debug" : "ready"));
            if (this.onSwitchDebugger) {
                this.onSwitchDebugger(this.pyWorker.isSuspended);
            }
            if (this.dbgCurrentLine != null) {
                this.srcEditor.setReadOnly(false);
                this.srcEditor.session.removeGutterDecoration(this.dbgCurrentLine - 1, "dbg-current-line");
                this.dbgCurrentLine = null;
            }
            if (this.pyWorker.isSuspended) {
                this.srcEditor.setReadOnly(true);
                this.dbgCurrentLine = this.pyWorker.dbgCurrentLine;
                this.srcEditor.session.addGutterDecoration(this.dbgCurrentLine - 1, "dbg-current-line");
            }
        };

        this.pyWorker.onTerminated = () => {
            if (this.onTerminated) {
                this.onTerminated();
            }
        };

        this.pyWorker.sharedOutput = true;
        this.pyWorker.onOutput = (text, append) => {
            if (append) {
                this.outputEditor.gotoLine(1e9);
                this.outputEditor.insert(text);
            } else {
                this.outputEditor.setValue(text);
                this.outputEditor.gotoLine(1e9);
            }
        };
        this.pyWorker.onFigure = (imageDataURL) => {
            if (this.figure) {
                this.figure.src = imageDataURL;
            }
            if (this.onChangeFigure) {
                this.onChangeFigure();
            }
        };
        this.pyWorker.onDirtyFile = (path) => {
            this.dirtyFiles.push(path);
        };
        this.pyWorker.onFile = options.onFile || null;
        this.pyWorker.onTimeout = () => {
            this.pyWorker.printToOutput("\nTimeout\n");
        };
        this.pyWorker.onInput = (prompt) => {
            this.outputEditor.gotoLine(1e9);
            this.outputEditor.setReadOnly(false);
            document.getElementById(this.outputEditorId).parentElement.className = "expect-input";
            this.inputStart = this.outputEditor.getSelectionRange().start;
            this.outputEditor.focus();
        };

        this.pyWorker.preload();

        // inline input
        this.outputEditor.commands.on("exec", (e) => {
            if (!e.command.readOnly) {
                let range = this.outputEditor.selection.getRange();
                let lastRow = this.outputEditor.session.getLength() - 1;
                if (range.start.row !== lastRow ||
                    (e.command.name == "backspace" || e.command.name == "removewordleft") &&
                        range.start.column === 0 && range.end.column === 0) {
                    e.preventDefault();
                }
            }
        });
        this.outputEditor.container.addEventListener("keypress", (keyEvent) => {
            if (this.inputStart && keyEvent.key === "Enter") {
                this.outputEditor.gotoLine(1e9);
                const currentPos = this.outputEditor.selection.getCursor();
                const inputRange = new ace.Range(this.inputStart.row, this.inputStart.column,
                    currentPos.row, currentPos.column);
                const str = this.outputEditor.session.getTextRange(inputRange);
                this.outputEditor.insert("\n");
                this.outputEditor.setReadOnly(true);
                document.getElementById(this.outputEditorId).parentElement.className = "dont-expect-input";
                this.inputStart = null;
                this.pyWorker.submitInput(str);
            }
            return false;
        }, true);
        this.outputEditor.commands.addCommand({
            name: "cancel-input",
            bindKey: "Esc",
            exec: () => {
                this.cancelInput();
            }
        });

    }

    cancelInput() {
        this.pyWorker.cancelInput();
        this.outputEditor.setReadOnly(true);
        document.getElementById(this.outputEditorId).parentElement.className = "dont-expect-input";
        this.inputStart = null;
    }

    clear() {
        this.pyWorker.clearOutput();
        this.pyWorker.clearFigure();
        if (this.inputStart) {
            this.inputStart = this.outputEditor.getSelectionRange().start;
            this.outputEditor.focus();
        }
    }

    printToOutput(str) {
        this.pyWorker.printToOutput(str);
    }

    getDirtyFiles() {
        return this.dirtyFiles;
    }

    resetDirtyFiles() {
        this.dirtyFiles = [];
    }

    getFile(path) {
        return this.pyWorker.getFile(path);
    }

    getBreakpoints() {
        const breakpoints = this.srcEditor.session.getBreakpoints();
        const bpLines = breakpoints
            .map((cls, i) => cls ? i + 1 : null)
            .filter((line) => line !== null);
        return bpLines;
    }

    static get statusStartup() {
        return "startup";
    }
    static get statusReady() {
        return "ready";
    }
    static get statusRunning() {
        return "running";
    }

    changeStatus(status) {
        if (this.onChangeStatus) {
            this.onChangeStatus(status);
        }
    }

    run() {
        const src = this.srcEditor.getValue();
        this.pyWorker.run(src, this.getBreakpoints());
        this.changeStatus(PyodideUI.statusRunning);
    }

    stop() {
        if (this.inputStart) {
            this.cancelInput();
        } else {
            this.pyWorker.stop();
            this.pyWorker.preload();
            this.changeStatus(PyodideUI.statusStartup);
        }
    }

    setSource(src) {
        if (this.pyWorker.isSuspended) {
            this.pyWorker.dbgResume("quit");
        }
        this.srcEditor.setValue(src, 1);
        this.srcEditor.session.clearBreakpoints();
    }

    next() {
        this.pyWorker.dbgResume("next");
        this.changeStatus(PyodideUI.statusRunning);
    }

    stepIn() {
        this.pyWorker.dbgResume("step");
        this.changeStatus(PyodideUI.statusRunning);
    }

    stepOut() {
        this.pyWorker.dbgResume("return");
        this.changeStatus(PyodideUI.statusRunning);
    }

    continueDebugging() {
        this.pyWorker.dbgResume("continue");
        this.changeStatus(PyodideUI.statusRunning);
    }

    quitDebugging() {
        this.pyWorker.dbgResume("quit");
        this.changeStatus(PyodideUI.statusReady);
    }
}
