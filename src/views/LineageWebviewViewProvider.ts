import * as vscode from "vscode";
import * as path from "path";
import { LineageGraphData, LineageGraphNode, LineageGraphSettings } from "../types";
import { CollibraClient } from "../collibra/CollibraClient";
import { SqlLineageExtractor } from "../parser/SqlLineageExtractor";
import { ConnectionManager } from "../connection/ConnectionManager";

export class LineageWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "collibraLineageView";
  private _view?: vscode.WebviewView;
  private currentGraphData: LineageGraphData | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private currentAbortController: AbortController | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly collibraClient: CollibraClient,
    private readonly connectionManager: ConnectionManager
  ) {
    this.connectionManager.onDidChangeActiveConnection(conn => {
      this.collibraClient.setConnection(conn);
      this.refreshCurrentLineage();
    });

    this.connectionManager.onDidChangeConnections(() => {
      this.refreshCurrentLineage();
    });
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

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async message => {
      const config = vscode.workspace.getConfiguration("collibra");
      switch (message.type) {
        case "refresh":
          this.refreshCurrentLineage();
          break;
        case "openCollibra":
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;
        case "manageConnections":
          vscode.commands.executeCommand("collibra.manageConnections");
          break;
        case "setConnection":
          if (message.connectionId) {
            await this.connectionManager.setActiveConnection(message.connectionId);
            this.refreshCurrentLineage();
          }
          break;
        case "updateSetting":
          if (message.key && message.value !== undefined) {
            await config.update(message.key, message.value, vscode.ConfigurationTarget.Workspace);
            this.refreshCurrentLineage();
          }
          break;
      }
    });

    // Initial render
    this.refreshCurrentLineage();
  }

  public triggerCursorUpdate(editor: vscode.TextEditor): void {
    const config = vscode.workspace.getConfiguration("collibra");
    const autoRefresh = config.get<boolean>("autoRefresh", true);
    if (!autoRefresh) return;

    const debounceMs = config.get<number>("debounceMs", 200);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.updateForEditor(editor);
    }, debounceMs);
  }

  public async updateForEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this._view) return;
    if (
      editor.document.languageId !== "sql" &&
      editor.document.languageId !== "jinja-sql" &&
      !editor.document.fileName.endsWith(".sql")
    ) {
      return;
    }

    // Cancel any previous in-flight request
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    const baseName = path.basename(editor.document.fileName);
    this._view.webview.postMessage({
      type: "setLoading",
      loading: true,
      fileName: baseName
    });

    const config = vscode.workspace.getConfiguration("collibra");
    const projectTypeSetting = config.get<"auto" | "dbt" | "pure sql">("projectType", "auto");
    const dwhBackend = config.get<"singlestore" | "postgres" | "mysql">("dwhBackend", "singlestore");
    const defaultSchema = config.get<string>("defaultSchema", dwhBackend === "singlestore" ? "landing" : "pagila");
    const depth = config.get<number>("lineage.depth", 2);
    const showColumnLevel = config.get<boolean>("lineage.showColumnLevel", true);
    const showDataTypes = config.get<boolean>("lineage.showDataTypes", true);
    const dbtTargetPath = config.get<string>("dbtTargetPath", "target/compiled");

    const position = editor.selection.active;

    const statement = SqlLineageExtractor.extractStatementAtCursor(
      editor.document,
      position,
      defaultSchema,
      {
        projectType: projectTypeSetting,
        dwhBackend,
        defaultSchema,
        dbtTargetPath
      }
    );

    const connections = await this.connectionManager.getConnections();
    const activeConn = await this.connectionManager.getActiveConnection();
    const availableConnections = connections.map(c => ({ id: c.id, name: c.name, isDefault: c.isDefault }));

    const effectiveProjectType: "pure sql" | "dbt" =
      projectTypeSetting === "auto"
        ? (SqlLineageExtractor.isDbtDocument(editor.document, "auto") ? "dbt" : "pure sql")
        : (projectTypeSetting as "pure sql" | "dbt");

    const settings: LineageGraphSettings = {
      projectType: effectiveProjectType,
      dwhBackend,
      depth,
      showColumnLevel,
      showDataTypes
    };

    if (signal.aborted) return;

    if (!statement) {
      this.sendGraphData({
        statementInfo: null,
        activeConnectionName: activeConn?.name || "Disconnected",
        activeConnectionId: activeConn?.id,
        availableConnections,
        settings,
        nodes: [],
        edges: [],
        timestamp: Date.now(),
        errorMessage: "No SQL statement or dbt model found."
      });
      this._view.webview.postMessage({ type: "setLoading", loading: false });
      return;
    }

    try {
      const graphData = await this.collibraClient.buildLineageGraph(statement, {
        depth,
        showColumnLevel,
        showDataTypes,
        settings,
        availableConnections,
        activeConnectionId: activeConn?.id
      }, signal);

      if (signal.aborted) return;
      this.currentGraphData = graphData;
      this.sendGraphData(graphData);
      this._view.webview.postMessage({ type: "setLoading", loading: false });
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        return;
      }
      this.sendGraphData({
        statementInfo: statement,
        activeConnectionName: activeConn?.name || "Disconnected",
        activeConnectionId: activeConn?.id,
        availableConnections,
        settings,
        nodes: [],
        edges: [],
        timestamp: Date.now(),
        errorMessage: `Collibra catalog error: ${err.message || String(err)}`
      });
      this._view.webview.postMessage({ type: "setLoading", loading: false });
    }
  }

  public refreshCurrentLineage(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.updateForEditor(editor);
    }
  }

  private sendGraphData(data: LineageGraphData): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: "setGraphData",
        data
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collibra SQL & dbt Lineage</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-panel-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --collibra-blue: #1b56dc;
      --collibra-cyan: #00d2ff;
      --badge-approved: #10b981;
      --badge-candidate: #f59e0b;
      --type-badge-bg: rgba(255, 255, 255, 0.08);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--bg);
      color: var(--fg);
      padding: 10px;
      overflow-x: hidden;
    }

    /* Top Control Bar */
    .top-bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-bottom: 10px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }

    .row-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .conn-select-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #10b981;
      flex-shrink: 0;
    }

    select.conn-dropdown {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 0.85em;
      flex: 1;
      min-width: 0;
      cursor: pointer;
    }

    .btn-group {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }

    .icon-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 3px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.78em;
      transition: background 0.15s;
    }
    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    /* Tunable Settings Ribbon */
    .settings-ribbon {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      font-size: 0.8em;
      background: rgba(255, 255, 255, 0.03);
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .ribbon-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .ribbon-select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 0.9em;
      cursor: pointer;
    }

    .depth-group {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    .depth-btn {
      background: var(--bg);
      border: none;
      color: var(--fg);
      padding: 2px 6px;
      font-size: 0.85em;
      cursor: pointer;
    }
    .depth-btn.active {
      background: var(--collibra-blue);
      color: #fff;
      font-weight: 600;
    }

    .toggle-label {
      display: flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      user-select: none;
    }

    /* Query Banner */
    .query-banner {
      background: rgba(27, 86, 220, 0.1);
      border: 1px solid rgba(27, 86, 220, 0.3);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 12px;
      font-size: 0.85em;
    }
    .query-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .badge-tag {
      display: inline-block;
      background: var(--collibra-blue);
      color: #fff;
      font-size: 0.72em;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
    }
    .origin-badge {
      display: inline-block;
      background: rgba(16, 185, 129, 0.2);
      color: #10b981;
      font-size: 0.72em;
      padding: 2px 6px;
      border-radius: 3px;
      margin-left: 4px;
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .query-sql {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
      white-space: pre-wrap;
      max-height: 60px;
      overflow-y: auto;
      background: rgba(0,0,0,0.25);
      padding: 5px;
      border-radius: 4px;
      color: #ddd;
    }

    /* Graph Section */
    .graph-section {
      margin-bottom: 14px;
    }
    .section-title {
      font-size: 0.78em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground, #888);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
    }

    .lineage-flow {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .flow-row {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .flow-row-header {
      font-size: 0.75em;
      font-weight: 600;
      color: var(--vscode-descriptionForeground, #888);
    }

    .node-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
    }

    .graph-node {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }
    .graph-node:hover {
      border-color: var(--collibra-blue);
      transform: translateY(-1px);
    }
    .graph-node.active-selected {
      border-color: var(--collibra-cyan);
      box-shadow: 0 0 0 1px var(--collibra-cyan);
    }
    .graph-node.role-source { border-left: 4px solid #38bdf8; }
    .graph-node.role-current_query {
      border-left: 4px solid var(--collibra-blue);
      background: rgba(27, 86, 220, 0.08);
    }
    .graph-node.role-target { border-left: 4px solid #10b981; }
    .graph-node.role-catalog_upstream { border-left: 4px solid #a855f7; opacity: 0.95; }
    .graph-node.role-catalog_downstream { border-left: 4px solid #ec4899; opacity: 0.95; }

    .node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .node-name {
      font-weight: 600;
      font-size: 0.92em;
    }
    .node-type-pill {
      font-size: 0.72em;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.06);
      color: #aaa;
    }
    .node-sub {
      color: #888;
      font-family: monospace;
      font-size: 0.85em;
      margin-top: 2px;
    }

    /* Column Listing inside Node */
    .node-columns-container {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed rgba(255,255,255,0.08);
    }
    .columns-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 4px;
    }
    .col-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.78em;
      padding: 2px 4px;
      background: rgba(0,0,0,0.2);
      border-radius: 3px;
    }
    .col-name {
      font-family: monospace;
      color: #ccc;
    }
    .col-type {
      font-size: 0.7em;
      padding: 1px 4px;
      border-radius: 2px;
      background: rgba(27, 86, 220, 0.2);
      color: #7dd3fc;
      border: 1px solid rgba(56, 189, 248, 0.3);
      font-family: monospace;
    }

    .node-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 6px;
      font-size: 0.76em;
    }
    .status-badge {
      padding: 1px 6px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.75em;
    }
    .status-approved { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .status-candidate { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .status-query { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .status-unregistered { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

    .connector-arrow {
      text-align: center;
      color: #666;
      font-size: 1.1em;
      margin: -3px 0;
    }

    /* Details Drawer */
    .details-drawer {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-top: 12px;
      display: none;
    }
    .details-drawer.visible { display: block; }
    .drawer-title { font-size: 1.05em; font-weight: 700; }
    .drawer-sub { font-size: 0.8em; color: #888; font-family: monospace; }
    .attr-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85em; }
    .attr-table td { padding: 4px 0; vertical-align: top; }
    .attr-table td.label { color: #888; width: 35%; }
    .attr-table td.val { color: var(--fg); font-weight: 500; }
    .portal-link {
      display: inline-block;
      margin-top: 10px;
      background: var(--collibra-blue);
      color: #fff;
      padding: 5px 10px;
      border-radius: 4px;
      font-size: 0.82em;
      font-weight: 600;
      cursor: pointer;
      border: none;
      width: 100%;
      text-align: center;
    }

    .empty-state {
      text-align: center;
      padding: 30px 16px;
      color: #888;
    }
    .empty-icon { font-size: 2.2em; margin-bottom: 8px; opacity: 0.6; }
  </style>
</head>
<body>
  <div class="top-bar">
    <!-- Row 1: Connection Selector & Action Buttons -->
    <div class="row-main">
      <div class="conn-select-group">
        <div class="status-dot"></div>
        <select class="conn-dropdown" id="connSelect" title="Active Collibra Connection"></select>
      </div>
      <div class="btn-group">
        <button class="icon-btn" id="refreshBtn" title="Refresh Lineage">↻ Refresh</button>
        <button class="icon-btn" id="connSettingsBtn" title="Manage Connections">⚙</button>
      </div>
    </div>

    <!-- Row 2: Tunable Settings Ribbon -->
    <div class="settings-ribbon">
      <div class="ribbon-item">
        <span>Type:</span>
        <select class="ribbon-select" id="projectTypeSelect" title="Project mode">
          <option value="auto">Auto</option>
          <option value="dbt">dbt</option>
          <option value="pure sql">Pure SQL</option>
        </select>
      </div>

      <div class="ribbon-item">
        <span>DWH:</span>
        <select class="ribbon-select" id="dwhBackendSelect" title="DWH Dialect">
          <option value="singlestore">SingleStore</option>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
        </select>
      </div>

      <div class="ribbon-item">
        <span>Depth:</span>
        <div class="depth-group">
          <button class="depth-btn" data-depth="1">1</button>
          <button class="depth-btn" data-depth="2">2</button>
          <button class="depth-btn" data-depth="3">3</button>
        </div>
      </div>

      <div class="ribbon-item">
        <label class="toggle-label">
          <input type="checkbox" id="chkColumns" checked>
          <span>Cols</span>
        </label>
      </div>

      <div class="ribbon-item">
        <label class="toggle-label">
          <input type="checkbox" id="chkDataTypes" checked>
          <span>Types</span>
        </label>
      </div>
    </div>
  </div>

  <div id="contentContainer">
    <!-- Loading State -->
    <div id="loadingIndicator" style="display:none; padding:8px 10px; margin-bottom:10px; background:rgba(0,122,204,0.15); border:1px solid rgba(0,122,204,0.4); border-radius:4px; font-size:0.82em; display:none; align-items:center; gap:8px;">
      <span style="display:inline-block; font-size:1.1em;">⏳</span>
      <span id="loadingFileName">Analyzing lineage...</span>
    </div>

    <!-- Manifest Missing Warning Banner -->
    <div id="manifestWarningBanner" style="display:none; padding:12px; margin-bottom:12px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4); border-radius:6px; font-size:0.85em;">
      <div style="font-weight:600; color:#f59e0b; margin-bottom:6px; display:flex; align-items:center; gap:6px;">
        <span>⚠️</span>
        <span>target/manifest.json Not Found</span>
      </div>
      <p style="margin-bottom:8px; line-height:1.4; color:var(--fg);">
        dbt model database, schema, table alias, and upstream lineage cannot be determined without <code>target/manifest.json</code>.
      </p>
      <div style="font-size:0.8em; color:#aaa; margin-bottom:10px;">
        Run <code>dbt compile</code> in your terminal to build the manifest, then refresh.
      </div>
      <button class="icon-btn" onclick="vscode.postMessage({ type: 'refresh' })" style="background:var(--collibra-blue); color:#fff; border:none; padding:4px 10px; font-weight:600;">
        🔄 Refresh Lineage
      </button>
    </div>

    <!-- Query Banner -->
    <div class="query-banner" id="queryBanner" style="display:none;">
      <div class="query-meta">
        <div>
          <span class="badge-tag" id="queryTypeBadge">SELECT</span>
          <span class="origin-badge" id="queryOriginBadge">dbt target</span>
        </div>
        <span id="queryLines" style="font-size:0.8em; color:#888;"></span>
      </div>
      <div class="query-sql" id="querySqlPreview"></div>
    </div>

    <!-- Lineage Flow -->
    <div class="graph-section" id="graphSection" style="display:none;">
      <div class="section-title">
        <span>Lineage Flow Hierarchy</span>
        <span id="nodeCountBadge">0 objects</span>
      </div>

      <div class="lineage-flow" id="lineageFlow">
        <!-- Upstream Sources -->
        <div class="flow-row" id="rowSources">
          <div class="flow-row-header">
            <span>📥 Upstream Sources (Tables / Seeds)</span>
          </div>
          <div class="node-grid" id="sourcesGrid"></div>
        </div>

        <div class="connector-arrow">▼</div>

        <!-- Current Query / Transformation -->
        <div class="flow-row" id="rowCurrentQuery">
          <div class="flow-row-header">
            <span>⚡ Active Transformation / Model</span>
          </div>
          <div class="node-grid" id="currentQueryGrid"></div>
        </div>

        <!-- Downstream Targets -->
        <div class="connector-arrow" id="downstreamArrow" style="display:none;">▼</div>
        <div class="flow-row" id="rowTargets" style="display:none;">
          <div class="flow-row-header">
            <span>📤 Downstream Target Models</span>
          </div>
          <div class="node-grid" id="targetsGrid"></div>
        </div>

        <!-- Downstream BI -->
        <div class="connector-arrow" id="biArrow" style="display:none;">▼</div>
        <div class="flow-row" id="rowBI" style="display:none;">
          <div class="flow-row-header">
            <span>📊 Downstream Collibra BI Dashboards</span>
          </div>
          <div class="node-grid" id="biGrid"></div>
        </div>
      </div>
    </div>

    <!-- Node Detail Drawer -->
    <div class="details-drawer" id="detailsDrawer">
      <div class="drawer-header">
        <div class="drawer-title" id="drawerTitle">Asset Name</div>
        <div class="drawer-sub" id="drawerSub">landing.raw_customers</div>
      </div>
      <table class="attr-table" id="drawerAttrTable"></table>
      <div id="drawerActions"></div>
    </div>

    <!-- Empty State -->
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">🧭</div>
      <p><strong>Move cursor to any SQL query or dbt model</strong></p>
      <p style="font-size:0.85em; margin-top:4px;">Supports both pure SQL scratchpads and dbt academy models with live SingleStore & Collibra governance catalog lineage.</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentData = null;
    let selectedNodeId = null;

    // Action buttons
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('connSettingsBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'manageConnections' });
    });

    // Connection Switcher
    document.getElementById('connSelect').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setConnection', connectionId: e.target.value });
    });

    // Project Type Selector
    document.getElementById('projectTypeSelect').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'updateSetting', key: 'projectType', value: e.target.value });
    });

    // DWH Backend Selector
    document.getElementById('dwhBackendSelect').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'updateSetting', key: 'dwhBackend', value: e.target.value });
    });

    // Depth Buttons
    document.querySelectorAll('.depth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const depth = parseInt(btn.getAttribute('data-depth'), 10);
        vscode.postMessage({ type: 'updateSetting', key: 'lineage.depth', value: depth });
      });
    });

    // Checkbox toggles
    document.getElementById('chkColumns').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'updateSetting', key: 'lineage.showColumnLevel', value: e.target.checked });
    });

    document.getElementById('chkDataTypes').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'updateSetting', key: 'lineage.showDataTypes', value: e.target.checked });
    });

    // Listen to messages from extension backend
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'setGraphData') {
        renderLineage(msg.data);
      } else if (msg.type === 'setLoading') {
        const loader = document.getElementById('loadingIndicator');
        if (loader) {
          loader.style.display = msg.loading ? 'flex' : 'none';
          const nameSpan = document.getElementById('loadingFileName');
          if (nameSpan) {
            nameSpan.innerText = 'Analyzing lineage for ' + (msg.fileName || 'model') + '...';
          }
        }
      }
    });

    function renderLineage(data) {
      currentData = data;

      // Manifest Missing Warning
      const manifestWarning = document.getElementById('manifestWarningBanner');
      if (data.manifestMissing) {
        if (manifestWarning) manifestWarning.style.display = 'block';
        document.getElementById('queryBanner').style.display = 'none';
        document.getElementById('graphSection').style.display = 'none';
        document.getElementById('detailsDrawer').classList.remove('visible');
        document.getElementById('emptyState').style.display = 'none';
        return;
      } else if (manifestWarning) {
        manifestWarning.style.display = 'none';
      }

      // Update Connections Dropdown
      const connSelect = document.getElementById('connSelect');
      connSelect.innerHTML = '';
      if (data.availableConnections && data.availableConnections.length > 0) {
        data.availableConnections.forEach(conn => {
          const opt = document.createElement('option');
          opt.value = conn.id;
          opt.innerText = conn.name;
          if (conn.id === data.activeConnectionId) opt.selected = true;
          connSelect.appendChild(opt);
        });
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.innerText = data.activeConnectionName || 'Default Collibra';
        connSelect.appendChild(opt);
      }

      // Update Settings UI Ribbon
      if (data.settings) {
        if (data.settings.projectType) {
          document.getElementById('projectTypeSelect').value = data.settings.projectType;
        }
        if (data.settings.dwhBackend) {
          document.getElementById('dwhBackendSelect').value = data.settings.dwhBackend;
        }
        document.querySelectorAll('.depth-btn').forEach(btn => {
          const d = parseInt(btn.getAttribute('data-depth'), 10);
          btn.classList.toggle('active', d === data.settings.depth);
        });
        document.getElementById('chkColumns').checked = data.settings.showColumnLevel !== false;
        document.getElementById('chkDataTypes').checked = data.settings.showDataTypes !== false;
      }

      if (!data.statementInfo || (data.nodes.length === 0 && !data.statementInfo.cleanSql)) {
        document.getElementById('queryBanner').style.display = 'none';
        document.getElementById('graphSection').style.display = 'none';
        document.getElementById('detailsDrawer').classList.remove('visible');
        document.getElementById('emptyState').style.display = 'block';
        return;
      }

      document.getElementById('emptyState').style.display = 'none';

      // Query Banner
      const banner = document.getElementById('queryBanner');
      banner.style.display = 'block';
      const stmt = data.statementInfo;
      document.getElementById('queryTypeBadge').innerText = stmt.statementType.replace(/_/g, ' ');

      // Origin badge
      const originBadge = document.getElementById('queryOriginBadge');
      if (stmt.origin === 'dbt_manifest') {
        originBadge.innerText = 'dbt manifest';
        const d = stmt.manifestDetails;
        originBadge.title = d ? (d.database + '.' + d.schema + '.' + (d.alias || d.name)) : 'Derived from target/manifest.json';
        originBadge.style.display = 'inline-block';
      } else if (stmt.origin === 'dbt_target') {
        originBadge.innerText = 'dbt Target (Compiled)';
        originBadge.title = stmt.resolvedFilePath || 'Compiled target SQL';
        originBadge.style.display = 'inline-block';
      } else if (stmt.origin === 'dbt_jinja_fallback') {
        originBadge.innerText = 'dbt Model (Jinja AST)';
        originBadge.title = 'Extracted directly from Jinja refs and sources';
        originBadge.style.display = 'inline-block';
      } else {
        originBadge.innerText = 'SQL Query';
        originBadge.style.display = 'inline-block';
      }

      document.getElementById('queryLines').innerText = 'Lines ' + (stmt.startLine + 1) + '-' + (stmt.endLine + 1);
      document.getElementById('querySqlPreview').innerText = stmt.cleanSql;

      // Render Graph Nodes
      document.getElementById('graphSection').style.display = 'block';

      const sources = data.nodes.filter(n => n.role === 'source' || n.role === 'catalog_upstream');
      const queries = data.nodes.filter(n => n.role === 'current_query');
      const targets = data.nodes.filter(n => n.role === 'target');
      const biAssets = data.nodes.filter(n => n.role === 'catalog_downstream');

      const totalDbObjects = sources.length + targets.length + biAssets.length;
      document.getElementById('nodeCountBadge').innerText = totalDbObjects === 1 ? '1 table/view' : totalDbObjects + ' tables/views';

      // Sources Grid
      const sourcesGrid = document.getElementById('sourcesGrid');
      sourcesGrid.innerHTML = '';
      if (sources.length === 0) {
        sourcesGrid.innerHTML = '<div style="font-size:0.8em; color:#888; font-style:italic;">(No external source tables identified)</div>';
      } else {
        sources.forEach(node => sourcesGrid.appendChild(createNodeElement(node, data.settings)));
      }

      // Query Grid
      const currentQueryGrid = document.getElementById('currentQueryGrid');
      currentQueryGrid.innerHTML = '';
      queries.forEach(node => currentQueryGrid.appendChild(createNodeElement(node, data.settings)));

      // Targets Grid
      const rowTargets = document.getElementById('rowTargets');
      const downstreamArrow = document.getElementById('downstreamArrow');
      const targetsGrid = document.getElementById('targetsGrid');
      targetsGrid.innerHTML = '';
      if (targets.length > 0) {
        rowTargets.style.display = 'block';
        downstreamArrow.style.display = 'block';
        targets.forEach(node => targetsGrid.appendChild(createNodeElement(node, data.settings)));
      } else {
        rowTargets.style.display = 'none';
        downstreamArrow.style.display = 'none';
      }

      // BI Downstream Grid
      const rowBI = document.getElementById('rowBI');
      const biArrow = document.getElementById('biArrow');
      const biGrid = document.getElementById('biGrid');
      biGrid.innerHTML = '';
      if (biAssets.length > 0) {
        rowBI.style.display = 'block';
        biArrow.style.display = 'block';
        biAssets.forEach(node => biGrid.appendChild(createNodeElement(node, data.settings)));
      } else {
        rowBI.style.display = 'none';
        biArrow.style.display = 'none';
      }

      // Smart default selection
      if (selectedNodeId) {
        const stillExists = data.nodes.find(n => n.id === selectedNodeId);
        if (stillExists) {
          selectNode(stillExists);
        } else if (targets.length > 0) {
          selectNode(targets[0]);
        } else if (sources.length > 0) {
          selectNode(sources[0]);
        }
      } else if (targets.length > 0) {
        selectNode(targets[0]);
      } else if (sources.length > 0) {
        selectNode(sources[0]);
      }
    }

    function createNodeElement(node, settings) {
      const div = document.createElement('div');
      div.className = 'graph-node role-' + node.role + (selectedNodeId === node.id ? ' active-selected' : '');
      div.id = 'el-' + node.id;
      div.onclick = () => selectNode(node);

      let statusClass = 'status-unregistered';
      let statusText = node.status || 'Not in Collibra';
      if (node.role === 'current_query') {
        statusClass = 'status-query';
        statusText = node.status || 'Active DDL';
      } else if (node.status === 'Approved' || (node.status && node.status.includes('Gold'))) {
        statusClass = 'status-approved';
      } else if (node.status === 'Candidate' || node.status === 'In Review') {
        statusClass = 'status-candidate';
      }

      // Column Level Rendering
      let columnsHtml = '';
      const showCols = settings ? settings.showColumnLevel !== false : true;
      const showTypes = settings ? settings.showDataTypes !== false : true;

      if (showCols && node.columns && node.columns.length > 0) {
        columnsHtml = '<div class="node-columns-container"><div class="columns-list">';
        node.columns.forEach(col => {
          const typeBadge = showTypes && col.dataType ? '<span class="col-type">' + escapeHtml(col.dataType) + '</span>' : '';
          columnsHtml += \`
            <div class="col-row">
              <span class="col-name">• \${escapeHtml(col.name)}</span>
              \${typeBadge}
            </div>
          \`;
        });
        columnsHtml += '</div></div>';
      }

      div.innerHTML = \`
        <div class="node-header">
          <span class="node-name">\${escapeHtml(node.displayName || node.name)}</span>
          <span class="node-type-pill">\${escapeHtml(node.type)}</span>
        </div>
        <div class="node-sub">\${escapeHtml(node.name)}</div>
        \${columnsHtml}
        <div class="node-footer">
          <span style="font-size:0.8em; color:#888;">\${escapeHtml(node.role.replace(/_/g, ' '))}</span>
          <span class="status-badge \${statusClass}">\${escapeHtml(statusText)}</span>
        </div>
      \`;
      return div;
    }

    function selectNode(node) {
      selectedNodeId = node.id;
      document.querySelectorAll('.graph-node').forEach(el => el.classList.remove('active-selected'));
      const activeEl = document.getElementById('el-' + node.id);
      if (activeEl) activeEl.classList.add('active-selected');

      const drawer = document.getElementById('detailsDrawer');
      drawer.classList.add('visible');

      document.getElementById('drawerTitle').innerText = node.displayName || node.name;
      document.getElementById('drawerSub').innerText = node.name + ' (' + node.type + ')';

      const table = document.getElementById('drawerAttrTable');
      table.innerHTML = '';

      // Attributes
      if (node.attributes && Object.keys(node.attributes).length > 0) {
        for (const [k, v] of Object.entries(node.attributes)) {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td class="label">\${escapeHtml(k)}:</td>
            <td class="val">\${escapeHtml(String(v))}</td>
          \`;
          table.appendChild(tr);
        }
      }

      // Columns in drawer
      if (node.columns && node.columns.length > 0) {
        const trH = document.createElement('tr');
        trH.innerHTML = '<td colspan="2" style="font-weight:700; padding-top:8px; border-top:1px solid #333;">Catalog Columns:</td>';
        table.appendChild(trH);

        node.columns.forEach(col => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td class="label" style="font-family:monospace;">• \${escapeHtml(col.name)}</td>
            <td class="val"><span class="col-type">\${escapeHtml(col.dataType || 'varchar')}</span> \${escapeHtml(col.description || '')}</td>
          \`;
          table.appendChild(tr);
        });
      }

      const actionsDiv = document.getElementById('drawerActions');
      actionsDiv.innerHTML = '';
      if (node.collibraUrl) {
        const btn = document.createElement('button');
        btn.className = 'portal-link';
        btn.innerText = '🔗 View in Collibra Data Intelligence Cloud';
        btn.onclick = () => {
          vscode.postMessage({ type: 'openInCollibra', url: node.collibraUrl });
        };
        actionsDiv.appendChild(btn);
      }
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
