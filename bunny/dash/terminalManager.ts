import { spawn } from "bun";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TerminalMessage =
  | {
      type: "terminalOutput";
      terminalId: string;
      data: string;
    }
  | {
      type: "terminalExit";
      terminalId: string;
      exitCode: number;
      signal?: number;
    };

type TerminalSession = {
  id: string;
  process: any;
  cwd: string;
  shell: string;
  ready: boolean;
  currentCwd?: string;
  inputBuffer: string;
  stdoutReader?: ReadableStreamDefaultReader<Uint8Array>;
  stderrReader?: ReadableStreamDefaultReader<Uint8Array>;
};

type PtyMessage =
  | {
      type: "spawn";
      spawn: {
        shell: string;
        cwd: string;
        cols: number;
        rows: number;
      };
    }
  | {
      type: "input";
      input: {
        data: string;
      };
    }
  | {
      type: "resize";
      resize: {
        cols: number;
        rows: number;
      };
    }
  | {
      type: "shutdown";
    }
  | {
      type: "get_cwd";
    };

type PtyResponse = {
  type: "ready" | "data" | "error" | "cwd_update";
  data?: string;
  error_msg?: string;
};

export class TerminalManager {
  private terminals = new Map<string, TerminalSession>();

  constructor(private readonly emit: (message: TerminalMessage) => void) {}

  createTerminal(cwd: string = process.cwd(), shell?: string, cols = 80, rows = 24): string {
    const terminalId = randomUUID();
    const defaultShell =
      process.platform === "win32"
        ? "cmd.exe"
        : process.platform === "darwin"
          ? "/bin/zsh"
          : "/bin/bash";
    const terminalShell = shell || process.env.SHELL || defaultShell;
    const workerDir = dirname(fileURLToPath(import.meta.url));
    const ptyBinaryPath = join(
      workerDir,
      process.platform === "win32" ? "colab-pty.exe" : "colab-pty",
    );

    const proc = spawn([ptyBinaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: workerDir,
      // @ts-ignore Bun-specific custom binary flag
      allowUnsafeCustomBinary: true,
    });

    const terminal: TerminalSession = {
      id: terminalId,
      process: proc,
      cwd,
      shell: terminalShell,
      ready: false,
      currentCwd: cwd,
      inputBuffer: "",
    };

    this.terminals.set(terminalId, terminal);
    this.readPtyOutput(proc, terminalId);

    proc.exited.then((exitCode: number) => {
      const current = this.terminals.get(terminalId);
      if (current) {
        this.cleanupReaders(current);
      }
      this.emit({
        type: "terminalExit",
        terminalId,
        exitCode,
        signal: 0,
      });
      this.terminals.delete(terminalId);
    });

    this.sendPtyMessage(terminalId, {
      type: "spawn",
      spawn: {
        shell: terminalShell,
        cwd,
        cols,
        rows,
      },
    });

    return terminalId;
  }

  writeToTerminal(terminalId: string, data: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || !terminal.ready) {
      return false;
    }

    try {
      let nextData = data;
      if (nextData.length > 1) {
        nextData = nextData.replace(/\x04/g, "");
        if (nextData.length === 0) {
          return true;
        }
      }

      if (nextData === "\r" || nextData === "\n") {
        terminal.inputBuffer = "";
      } else if (nextData === "\x7f" || nextData === "\b") {
        terminal.inputBuffer = terminal.inputBuffer.slice(0, -1);
      } else if (nextData === "\x03" || nextData === "\x15") {
        terminal.inputBuffer = "";
      } else if (nextData.length === 1 && nextData.charCodeAt(0) >= 32) {
        terminal.inputBuffer += nextData;
      }

      const MAX_CHUNK_SIZE = 2048;
      for (let index = 0; index < nextData.length; index += MAX_CHUNK_SIZE) {
        this.sendPtyMessage(terminalId, {
          type: "input",
          input: {
            data: nextData.slice(index, index + MAX_CHUNK_SIZE),
          },
        });
      }

      return true;
    } catch (error) {
      console.error("Error writing to PTY terminal:", error);
      return false;
    }
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
    if (!this.terminals.has(terminalId)) {
      return false;
    }

    try {
      this.sendPtyMessage(terminalId, {
        type: "resize",
        resize: { cols, rows },
      });
      return true;
    } catch (error) {
      console.error("Error resizing PTY terminal:", error);
      return false;
    }
  }

  killTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    try {
      this.cleanupReaders(terminal);
      this.sendPtyMessage(terminalId, { type: "shutdown" });
      setTimeout(() => {
        try {
          terminal.process.kill();
        } catch (error) {
          console.error("Error killing PTY process:", error);
        }
      }, 100);
      this.terminals.delete(terminalId);
      return true;
    } catch (error) {
      console.error("Error killing terminal:", error);
      return false;
    }
  }

  async getTerminalCwd(terminalId: string): Promise<string | null> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return null;
    }

    try {
      this.sendPtyMessage(terminalId, { type: "get_cwd" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return terminal.currentCwd || terminal.cwd;
    } catch (error) {
      console.error(`Error getting CWD for terminal ${terminalId}:`, error);
      return terminal.cwd;
    }
  }

  cleanup() {
    for (const terminal of this.terminals.values()) {
      try {
        this.cleanupReaders(terminal);
        this.sendPtyMessage(terminal.id, { type: "shutdown" });
        setTimeout(() => {
          try {
            terminal.process.kill();
          } catch (error) {
            console.error("Error killing PTY process during cleanup:", error);
          }
        }, 100);
      } catch (error) {
        console.error("Error during terminal cleanup:", error);
      }
    }
    this.terminals.clear();
  }

  private sendPtyMessage(terminalId: string, message: PtyMessage) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return;
    }

    try {
      terminal.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      console.error("Error sending PTY message:", error);
    }
  }

  private async readPtyOutput(proc: any, terminalId: string) {
    try {
      const stdoutReader = proc.stdout.getReader();
      const stderrReader = proc.stderr.getReader();
      const terminal = this.terminals.get(terminalId);
      if (terminal) {
        terminal.stdoutReader = stdoutReader;
        terminal.stderrReader = stderrReader;
      }

      void (async () => {
        try {
          let buffer = "";
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) {
              break;
            }

            buffer += new TextDecoder().decode(value);
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              try {
                const response = JSON.parse(line) as PtyResponse;
                this.handlePtyResponse(terminalId, response);
              } catch (error) {
                console.error("Error parsing PTY response:", error, line);
              }
            }
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            console.error("Error reading PTY stdout:", error);
          }
        }
      })();

      void (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) {
              break;
            }
            console.error(`PTY ${terminalId} stderr:`, new TextDecoder().decode(value));
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            console.error("Error reading PTY stderr:", error);
          }
        }
      })();
    } catch (error) {
      console.error("Error setting up PTY output readers:", error);
    }
  }

  private cleanupReaders(terminal: TerminalSession) {
    try {
      terminal.stdoutReader?.cancel();
    } catch {}
    try {
      terminal.stderrReader?.cancel();
    } catch {}
  }

  private handlePtyResponse(terminalId: string, response: PtyResponse) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return;
    }

    switch (response.type) {
      case "ready":
        terminal.ready = true;
        break;
      case "data":
        if (response.data) {
          this.emit({
            type: "terminalOutput",
            terminalId,
            data: response.data,
          });
        }
        break;
      case "cwd_update":
        if (response.data) {
          terminal.currentCwd = response.data;
        }
        break;
      case "error":
        this.emit({
          type: "terminalOutput",
          terminalId,
          data: `Error: ${response.error_msg}\r\n`,
        });
        break;
    }
  }
}
