// This method is called when your extension is deactivated
export function deactivate() {}

import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";

const TERMINAL_NAME = "opencode";

export function activate(context: vscode.ExtensionContext) {
  let openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal();
  });

  let openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    // An opencode terminal already exists => focus it
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    await openTerminal();
  });

  let addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile();
    if (!fileRef) {
      return;
    }

    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      return;
    }

    if (terminal.name === TERMINAL_NAME) {
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"];
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false);
      terminal.show();
    }
  });

  context.subscriptions.push(openTerminalDisposable, addFilepathDisposable);

  async function openTerminal() {
    // Create a new terminal in split screen
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_CALLER: "vscode",
      },
    });

    terminal.show();
    terminal.sendText(`opencode --port ${port}`);

    // VSCode 1.66対応：ターミナルをエディタ領域に移動して横並び表示を実現
    try {
      await vscode.commands.executeCommand("workbench.action.moveActiveEditorGroupRight");
    } catch (error) {
      console.warn("Failed to move terminal to side:", error);
    }

    const fileRef = getActiveFile();
    if (!fileRef) {
      return;
    }

    // Wait for the terminal to be ready - VSCode 1.66対応：httpモジュール使用
    let tries = 10;
    let connected = false;
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      connected = await checkConnection(port);
      tries--;
    } while (!connected && tries > 0);

    // VSCode 1.66対応：httpモジュールを使用した接続確認関数
    async function checkConnection(port: number): Promise<boolean> {
      try {
        const isHttps = port >= 443;
        const httpModule = isHttps ? https : http;

        return new Promise((resolve) => {
          const req = httpModule.request(
            {
              hostname: "localhost",
              port: port,
              path: "/app",
              method: "GET",
              timeout: 2000,
            },
            (res) => {
              resolve(res.statusCode === 200);
            },
          );

          req.on("error", () => resolve(false));
          req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
          });
          req.end();
        });
      } catch (error) {
        return false;
      }
    }

    // If connected, append the prompt to the terminal
    if (connected) {
      await appendPrompt(port, `In ${fileRef}`);
      terminal.show();
    } else {
      // VSCode 1.66対応：接続失敗時のエラーメッセージ表示
      vscode.window.showErrorMessage("Failed to connect to opencode server. Please check if the server is running.");
      return;
    }
  }

  async function appendPrompt(port: number, text: string) {
    try {
      const postData = JSON.stringify({ text });
      const isHttps = port >= 443;
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: "localhost",
        port: port,
        path: "/tui/append-prompt",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      };

      return new Promise<void>((resolve, reject) => {
        const req = httpModule.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });

        req.on("error", reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      console.error("Failed to append prompt:", error);
    }
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return;
    }

    const document = activeEditor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return;
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    let filepathWithAt = `@${relativePath}`;

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection;
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`;
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`;
      }
    }

    return filepathWithAt;
  }
}
