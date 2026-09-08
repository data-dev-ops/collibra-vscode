import * as vscode from "vscode";
import { ConnectionManager } from "./connection/ConnectionManager";
import { CollibraClient } from "./collibra/CollibraClient";
import { LineageWebviewViewProvider } from "./views/LineageWebviewViewProvider";
import { ConnectionWebviewViewProvider } from "./views/ConnectionWebviewViewProvider";

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Activating Collibra SQL Lineage Extension...");

  // 1. Initialize Connection Manager
  const connectionManager = new ConnectionManager(context);
  const activeConn = await connectionManager.getActiveConnection();

  // 2. Initialize Collibra REST API Client
  const collibraClient = new CollibraClient(activeConn);

  // 3. Register Lineage View Provider
  const lineageProvider = new LineageWebviewViewProvider(context, collibraClient, connectionManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LineageWebviewViewProvider.viewType,
      lineageProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 4. Register Connection Manager View Provider
  const connectionProvider = new ConnectionWebviewViewProvider(context, connectionManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConnectionWebviewViewProvider.viewType,
      connectionProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 5. Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "collibra.manageConnections";
  context.subscriptions.push(statusBarItem);
  updateStatusBar(activeConn);

  connectionManager.onDidChangeActiveConnection(conn => {
    updateStatusBar(conn);
  });

  // 6. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("collibra.openLineage", () => {
      vscode.commands.executeCommand("collibraLineageView.focus");
    }),
    vscode.commands.registerCommand("collibra.refreshLineage", () => {
      lineageProvider.refreshCurrentLineage();
    }),
    vscode.commands.registerCommand("collibra.refreshConnections", async () => {
      await connectionManager.syncFromConfiguration();
      await connectionProvider.updateWebview();
      vscode.window.showInformationMessage("Collibra connections reloaded.");
    }),
    vscode.commands.registerCommand("collibra.manageConnections", () => {
      vscode.commands.executeCommand("collibraConnectionView.focus");
    }),
    vscode.commands.registerCommand("collibra.testActiveConnection", async () => {
      const conn = await connectionManager.getActiveConnection();
      if (!conn) {
        vscode.window.showWarningMessage("No active Collibra connection configured.");
        return;
      }
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Testing connection to Collibra (${conn.url})...`
        },
        async () => {
          const res = await connectionManager.testConnection(conn);
          if (res.success) {
            vscode.window.showInformationMessage(res.message);
          } else {
            vscode.window.showErrorMessage(res.message);
          }
        }
      );
    })
  );

  // 7. Listen for Cursor Movements in SQL Editors
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor.document.languageId === "sql" || event.textEditor.document.fileName.endsWith(".sql")) {
        lineageProvider.triggerCursorUpdate(event.textEditor);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && (editor.document.languageId === "sql" || editor.document.fileName.endsWith(".sql"))) {
        lineageProvider.updateForEditor(editor);
      }
    })
  );

  // Trigger initial update if editor already active
  if (vscode.window.activeTextEditor) {
    lineageProvider.updateForEditor(vscode.window.activeTextEditor);
  }

  console.log("Collibra SQL Lineage Extension activated successfully.");
}

function updateStatusBar(conn: any) {
  if (conn) {
    statusBarItem.text = `$(database) Collibra: ${conn.name}`;
    statusBarItem.tooltip = `Connected to Collibra: ${conn.url} (${conn.username}). Click to manage.`;
    statusBarItem.show();
  } else {
    statusBarItem.text = `$(database) Collibra: Disconnected`;
    statusBarItem.tooltip = `No active Collibra connection. Click to add one.`;
    statusBarItem.show();
  }
}

export function deactivate() {}
