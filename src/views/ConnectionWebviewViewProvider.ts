import * as vscode from "vscode";
import { ConnectionManager } from "../connection/ConnectionManager";
import { CollibraConnection } from "../types";

export class ConnectionWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "collibraConnectionView";
  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager
  ) {
    this.connectionManager.onDidChangeConnections(() => this.updateWebview());
    this.connectionManager.onDidChangeActiveConnection(() => this.updateWebview());
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "refresh":
          this.updateWebview();
          break;
        case "saveConnection":
          await this.handleSaveConnection(message.connection);
          break;
        case "testConnection":
          await this.handleTestConnection(message.connection);
          break;
        case "setActive":
          await this.connectionManager.setActiveConnection(message.id);
          vscode.window.showInformationMessage(`Active Collibra connection changed.`);
          this.updateWebview();
          break;
        case "deleteConnection":
          await this.connectionManager.deleteConnection(message.id);
          vscode.window.showInformationMessage(`Deleted Collibra connection.`);
          this.updateWebview();
          break;
      }
    });

    this.updateWebview();
  }

  private async updateWebview(): Promise<void> {
    if (!this._view) return;
    const connections = await this.connectionManager.getConnections();
    const active = await this.connectionManager.getActiveConnection();

    this._view.webview.postMessage({
      type: "setConnections",
      connections,
      activeId: active?.id || null
    });
  }

  private async handleSaveConnection(data: any): Promise<void> {
    const conn: CollibraConnection = {
      id: data.id || "conn-" + Date.now(),
      name: data.name || "Collibra Service",
      url: (data.url || "http://localhost:8080").trim().replace(/\/+$/, ""),
      username: data.username || "admin",
      password: data.password || "",
      isDefault: false
    };

    await this.connectionManager.saveConnection(conn);
    await this.connectionManager.setActiveConnection(conn.id);
    vscode.window.showInformationMessage(`Saved and activated Collibra connection: "${conn.name}"`);
    this.updateWebview();
  }

  private async handleTestConnection(data: any): Promise<void> {
    if (!this._view) return;
    const conn: CollibraConnection = {
      id: data.id || "temp-test",
      name: data.name || "Test Connection",
      url: (data.url || "http://localhost:8080").trim().replace(/\/+$/, ""),
      username: data.username || "admin",
      password: data.password || ""
    };

    const result = await this.connectionManager.testConnection(conn);
    this._view.webview.postMessage({
      type: "testResult",
      success: result.success,
      message: result.message
    });
  }

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collibra Connection Manager</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --border: var(--vscode-panel-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --collibra-blue: #1b56dc;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--bg);
      color: var(--fg);
      padding: 12px;
    }

    h3 {
      font-size: 0.95em;
      font-weight: 600;
      margin-bottom: 10px;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .form-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
    }

    .form-group {
      margin-bottom: 10px;
    }
    label {
      display: block;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground, #aaa);
      margin-bottom: 4px;
      font-weight: 500;
    }
    input {
      width: 100%;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 0.9em;
      font-family: inherit;
      outline: none;
    }
    input:focus {
      border-color: var(--collibra-blue);
    }

    .btn-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    button {
      flex: 1;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 7px 10px;
      font-size: 0.85em;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover {
      opacity: 0.9;
    }
    button.btn-secondary {
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--border);
      color: var(--fg);
    }

    /* Test Result Badge */
    .test-result {
      margin-top: 10px;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 0.82em;
      display: none;
    }
    .test-result.success {
      display: block;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #10b981;
    }
    .test-result.error {
      display: block;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #ef4444;
    }

    /* Saved Connections List */
    .connections-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .conn-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .conn-card.active {
      border-left: 4px solid var(--collibra-blue);
    }
    .conn-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .conn-title {
      font-weight: 600;
      font-size: 0.9em;
    }
    .active-badge {
      background: rgba(27, 86, 220, 0.2);
      color: #38bdf8;
      font-size: 0.72em;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
    }
    .conn-url {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground, #888);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .conn-card-actions {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
    .btn-sm {
      padding: 3px 6px;
      font-size: 0.75em;
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 3px;
      cursor: pointer;
    }
    .btn-sm:hover {
      background: rgba(255,255,255,0.12);
    }
    .btn-sm.btn-del {
      color: #f87171;
    }
  </style>
</head>
<body>
  <h3>Add / Edit Collibra Connection</h3>
  <div class="form-container">
    <div class="form-group">
      <label for="name">Connection Name</label>
      <input type="text" id="name" value="Pagila Collibra Local" placeholder="e.g. Pagila Local, Staging Cloud">
    </div>
    <div class="form-group">
      <label for="url">Collibra URL (REST API v2)</label>
      <input type="text" id="url" value="http://localhost:8080" placeholder="http://localhost:8080 or https://company.collibra.com">
    </div>
    <div class="form-group">
      <label for="username">Username / Service Account</label>
      <input type="text" id="username" value="admin" placeholder="admin">
    </div>
    <div class="form-group">
      <label for="password">Password / API Token</label>
      <input type="password" id="password" value="password123" placeholder="password or token">
    </div>

    <div class="btn-row">
      <button class="btn-secondary" id="testBtn">Test Connection</button>
      <button id="saveBtn">Save & Activate</button>
    </div>

    <div class="test-result" id="testResult"></div>
  </div>

  <h3>Saved Connections</h3>
  <ul class="connections-list" id="connectionsList"></ul>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('testBtn').addEventListener('click', () => {
      const name = document.getElementById('name').value;
      const url = document.getElementById('url').value;
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      const resBox = document.getElementById('testResult');
      resBox.className = 'test-result';
      resBox.style.display = 'block';
      resBox.innerText = 'Connecting to ' + url + '...';

      vscode.postMessage({
        type: 'testConnection',
        connection: { name, url, username, password }
      });
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
      const name = document.getElementById('name').value;
      const url = document.getElementById('url').value;
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      vscode.postMessage({
        type: 'saveConnection',
        connection: { name, url, username, password }
      });
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'setConnections') {
        renderConnections(msg.connections || [], msg.activeId);
      } else if (msg.type === 'testResult') {
        const resBox = document.getElementById('testResult');
        resBox.style.display = 'block';
        resBox.className = 'test-result ' + (msg.success ? 'success' : 'error');
        resBox.innerText = msg.message;
      }
    });

    function renderConnections(connections, activeId) {
      const list = document.getElementById('connectionsList');
      list.innerHTML = '';

      if (connections.length === 0) {
        list.innerHTML = '<div style="color:#888; font-size:0.85em;">No saved connections.</div>';
        return;
      }

      connections.forEach(conn => {
        const isActive = conn.id === activeId;
        const li = document.createElement('li');
        li.className = 'conn-card' + (isActive ? ' active' : '');
        li.innerHTML = \`
          <div class="conn-card-header">
            <span class="conn-title">\${escapeHtml(conn.name)}</span>
            \${isActive ? '<span class="active-badge">ACTIVE</span>' : ''}
          </div>
          <div class="conn-url">\${escapeHtml(conn.url)} (\${escapeHtml(conn.username)})</div>
          <div class="conn-card-actions">
            \${!isActive ? '<button class="btn-sm" onclick="setActive(\\'' + conn.id + '\\')">Set Active</button>' : ''}
            <button class="btn-sm btn-del" onclick="deleteConn(\\'' + conn.id + '\\')">Delete</button>
          </div>
        \`;
        list.appendChild(li);
      });
    }

    function setActive(id) {
      vscode.postMessage({ type: 'setActive', id });
    }

    function deleteConn(id) {
      vscode.postMessage({ type: 'deleteConnection', id });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  }
}
