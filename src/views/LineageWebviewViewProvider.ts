import * as vscode from "vscode";
import { LineageGraphData, LineageGraphNode } from "../types";
import { CollibraClient } from "../collibra/CollibraClient";
import { SqlLineageExtractor } from "../parser/SqlLineageExtractor";
import { ConnectionManager } from "../connection/ConnectionManager";

export class LineageWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "collibraLineageView";
  private _view?: vscode.WebviewView;
  private currentGraphData: LineageGraphData | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly collibraClient: CollibraClient,
    private readonly connectionManager: ConnectionManager
  ) {
    // Listen for connection changes to refresh lineage
    this.connectionManager.onDidChangeActiveConnection(conn => {
      this.collibraClient.setConnection(conn);
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

    // Handle messages from Webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "refresh":
          this.refreshCurrentLineage();
          break;
        case "openInCollibra":
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;
        case "manageConnections":
          vscode.commands.executeCommand("collibra.manageConnections");
          break;
        case "openExternalUrl":
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
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

    const debounceMs = config.get<number>("debounceMs", 300);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.updateForEditor(editor);
    }, debounceMs);
  }

  public async updateForEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this._view) return;
    if (editor.document.languageId !== "sql" && !editor.document.fileName.endsWith(".sql")) {
      return;
    }

    const position = editor.selection.active;
    const defaultSchema = vscode.workspace.getConfiguration("collibra").get<string>("defaultSchema", "pagila");

    const statement = SqlLineageExtractor.extractStatementAtCursor(
      editor.document,
      position,
      defaultSchema
    );

    if (!statement) {
      this.sendGraphData({
        statementInfo: null,
        nodes: [],
        edges: [],
        timestamp: Date.now(),
        errorMessage: "No SQL statement found at cursor."
      });
      return;
    }

    try {
      const graphData = await this.collibraClient.buildLineageGraph(statement);
      this.currentGraphData = graphData;
      this.sendGraphData(graphData);
    } catch (err: any) {
      this.sendGraphData({
        statementInfo: statement,
        nodes: [],
        edges: [],
        timestamp: Date.now(),
        errorMessage: `Collibra catalog error: ${err.message || String(err)}`
      });
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
  <title>Collibra SQL Lineage</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-panel-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --badge-approved: #10b981;
      --badge-candidate: #f59e0b;
      --collibra-blue: #1b56dc;
      --collibra-cyan: #00d2ff;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--bg);
      color: var(--fg);
      padding: 12px;
      overflow-x: hidden;
    }

    /* Connection Bar */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 10px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .conn-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85em;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #10b981;
    }
    .conn-name {
      font-weight: 600;
      color: var(--fg);
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions-group {
      display: flex;
      gap: 6px;
    }
    .icon-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 3px 7px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      transition: background 0.15s;
    }
    .icon-btn:hover {
      background: rgba(255,255,255,0.08);
    }

    /* Query Banner */
    .query-banner {
      background: rgba(27, 86, 220, 0.12);
      border: 1px solid rgba(27, 86, 220, 0.3);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 14px;
      font-size: 0.88em;
    }
    .query-type-tag {
      display: inline-block;
      background: var(--collibra-blue);
      color: #fff;
      font-size: 0.72em;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
      margin-right: 6px;
      text-transform: uppercase;
    }
    .query-lines {
      color: var(--vscode-descriptionForeground, #888);
      font-size: 0.82em;
      float: right;
    }
    .query-sql {
      margin-top: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      white-space: pre-wrap;
      max-height: 70px;
      overflow-y: auto;
      color: var(--vscode-editor-foreground, #ccc);
      background: rgba(0,0,0,0.2);
      padding: 6px;
      border-radius: 4px;
    }

    /* Lineage Graph Visual */
    .graph-section {
      margin-bottom: 16px;
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
      gap: 12px;
      position: relative;
    }

    .flow-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .flow-row-header {
      font-size: 0.75em;
      font-weight: 600;
      color: var(--vscode-descriptionForeground, #888);
      display: flex;
      align-items: center;
      gap: 4px;
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
    .graph-node.role-source {
      border-left: 4px solid #38bdf8;
    }
    .graph-node.role-current_query {
      border-left: 4px solid var(--collibra-blue);
      background: rgba(27, 86, 220, 0.08);
    }
    .graph-node.role-target {
      border-left: 4px solid #10b981;
    }
    .graph-node.role-catalog_upstream {
      border-left: 4px solid #a855f7;
      opacity: 0.9;
    }
    .graph-node.role-catalog_downstream {
      border-left: 4px solid #ec4899;
      opacity: 0.9;
    }

    .node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .node-name {
      font-weight: 600;
      font-size: 0.92em;
      color: var(--fg);
    }
    .node-type-pill {
      font-size: 0.72em;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.06);
      color: var(--vscode-descriptionForeground, #aaa);
    }
    .node-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
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
    .status-proposed { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); }
    .status-query { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
    .status-unregistered { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

    .connector-arrow {
      text-align: center;
      color: var(--vscode-descriptionForeground, #666);
      font-size: 1.1em;
      margin: -4px 0;
    }

    /* Node Details Drawer */
    .details-drawer {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-top: 14px;
      display: none;
    }
    .details-drawer.visible {
      display: block;
    }
    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .drawer-title {
      font-size: 1.05em;
      font-weight: 700;
    }
    .drawer-sub {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground, #888);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .attr-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 0.85em;
    }
    .attr-table td {
      padding: 4px 0;
      vertical-align: top;
    }
    .attr-table td.label {
      color: var(--vscode-descriptionForeground, #888);
      width: 35%;
    }
    .attr-table td.val {
      color: var(--fg);
      font-weight: 500;
    }
    .portal-link {
      display: inline-block;
      margin-top: 10px;
      background: var(--collibra-blue);
      color: #fff;
      text-decoration: none;
      padding: 5px 10px;
      border-radius: 4px;
      font-size: 0.82em;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 30px 16px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .empty-icon {
      font-size: 2.2em;
      margin-bottom: 8px;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="conn-status">
      <div class="status-dot"></div>
      <span class="conn-name" id="connNameDisplay">Collibra Pagila</span>
    </div>
    <div class="actions-group">
      <button class="icon-btn" id="refreshBtn" title="Refresh Lineage at Cursor">↻ Refresh</button>
      <button class="icon-btn" id="connSettingsBtn" title="Manage Connections">⚙ Connect</button>
    </div>
  </div>

  <div id="contentContainer">
    <!-- Active Query Preview -->
    <div class="query-banner" id="queryBanner" style="display:none;">
      <div>
        <span class="query-type-tag" id="queryTypeBadge">SELECT</span>
        <span id="queryHeadline">Query Lineage</span>
        <span class="query-lines" id="queryLines">Lines 1-4</span>
      </div>
      <div class="query-sql" id="querySqlPreview"></div>
    </div>

    <!-- Lineage Graph Flow -->
    <div class="graph-section" id="graphSection" style="display:none;">
      <div class="section-title">
        <span>Lineage Flow Hierarchy</span>
        <span id="nodeCountBadge">0 objects</span>
      </div>

      <div class="lineage-flow" id="lineageFlow">
        <!-- Upstream Sources Row -->
        <div class="flow-row" id="rowSources">
          <div class="flow-row-header">
            <span>📥 Upstream Sources (Tables / Views)</span>
          </div>
          <div class="node-grid" id="sourcesGrid"></div>
        </div>

        <div class="connector-arrow">▼</div>

        <!-- Current Query Row -->
        <div class="flow-row" id="rowCurrentQuery">
          <div class="flow-row-header">
            <span>⚡ Active Query Transformation</span>
          </div>
          <div class="node-grid" id="currentQueryGrid"></div>
        </div>

        <!-- Downstream Targets Row (if CREATE/ALTER/INSERT) -->
        <div class="connector-arrow" id="downstreamArrow" style="display:none;">▼</div>
        <div class="flow-row" id="rowTargets" style="display:none;">
          <div class="flow-row-header">
            <span>📤 Downstream Targets (Models / Views)</span>
          </div>
          <div class="node-grid" id="targetsGrid"></div>
        </div>

        <!-- Downstream BI Products (from Collibra) -->
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
        <div>
          <div class="drawer-title" id="drawerTitle">Asset Name</div>
          <div class="drawer-sub" id="drawerSub">pagila.table</div>
        </div>
        <span class="status-badge status-approved" id="drawerStatusBadge">Approved</span>
      </div>
      <table class="attr-table" id="drawerAttrTable"></table>
      <div id="drawerActions"></div>
    </div>

    <!-- Empty State -->
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">🧭</div>
      <p><strong>Move cursor to any SQL statement</strong></p>
      <p style="font-size:0.85em; margin-top:4px;">Position cursor inside queries like <code>select a.* from pagila.a a join pagila.b b ...</code> to inspect live lineage and Collibra governance catalog data.</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentData = null;
    let selectedNodeId = null;

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('connSettingsBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'manageConnections' });
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'setGraphData') {
        renderLineage(msg.data);
      }
    });

    function renderLineage(data) {
      currentData = data;

      // Update connection indicator
      if (data.activeConnectionName) {
        document.getElementById('connNameDisplay').innerText = data.activeConnectionName;
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
      document.getElementById('queryLines').innerText = 'Lines ' + (stmt.startLine + 1) + '-' + (stmt.endLine + 1);
      document.getElementById('querySqlPreview').innerText = stmt.cleanSql;

      // Render Graph Nodes
      document.getElementById('graphSection').style.display = 'block';

      // Separate nodes by role
      const sources = data.nodes.filter(n => n.role === 'source' || n.role === 'catalog_upstream');
      const queries = data.nodes.filter(n => n.role === 'current_query');
      const targets = data.nodes.filter(n => n.role === 'target');
      const biAssets = data.nodes.filter(n => n.role === 'catalog_downstream');

      // Count only actual database objects (tables/views), not the query transformation node
      const totalDbObjects = sources.length + targets.length + biAssets.length;
      const countLabel = totalDbObjects === 1 ? '1 table/view' : totalDbObjects + ' tables/views';
      document.getElementById('nodeCountBadge').innerText = countLabel;

      // Sources
      const sourcesGrid = document.getElementById('sourcesGrid');
      sourcesGrid.innerHTML = '';
      if (sources.length === 0) {
        sourcesGrid.innerHTML = '<div style="font-size:0.8em; color:#888; font-style:italic;">(No external source tables identified)</div>';
      } else {
        sources.forEach(node => sourcesGrid.appendChild(createNodeElement(node)));
      }

      // Query Node
      const currentQueryGrid = document.getElementById('currentQueryGrid');
      currentQueryGrid.innerHTML = '';
      queries.forEach(node => currentQueryGrid.appendChild(createNodeElement(node)));

      // Targets
      const rowTargets = document.getElementById('rowTargets');
      const downstreamArrow = document.getElementById('downstreamArrow');
      const targetsGrid = document.getElementById('targetsGrid');
      targetsGrid.innerHTML = '';
      if (targets.length > 0) {
        rowTargets.style.display = 'block';
        downstreamArrow.style.display = 'block';
        targets.forEach(node => targetsGrid.appendChild(createNodeElement(node)));
      } else {
        rowTargets.style.display = 'none';
        downstreamArrow.style.display = 'none';
      }

      // BI Downstream
      const rowBI = document.getElementById('rowBI');
      const biArrow = document.getElementById('biArrow');
      const biGrid = document.getElementById('biGrid');
      biGrid.innerHTML = '';
      if (biAssets.length > 0) {
        rowBI.style.display = 'block';
        biArrow.style.display = 'block';
        biAssets.forEach(node => biGrid.appendChild(createNodeElement(node)));
      } else {
        rowBI.style.display = 'none';
        biArrow.style.display = 'none';
      }

      // Smart default selection: prefer targets (e.g. view being defined), then sources
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

    function createNodeElement(node) {
      const div = document.createElement('div');
      div.className = 'graph-node role-' + node.role + (selectedNodeId === node.id ? ' active-selected' : '');
      div.id = 'el-' + node.id;
      div.onclick = () => selectNode(node);

      let statusClass = 'status-unregistered';
      let statusText = node.status || 'Not in Collibra';
      if (node.role === 'current_query') {
        statusClass = 'status-query';
        statusText = node.status || 'Active DDL';
      } else if (node.status === 'Approved') {
        statusClass = 'status-approved';
      } else if (node.role === 'target' || (node.status && node.status.includes('Proposed'))) {
        statusClass = 'status-proposed';
        statusText = node.status || 'Proposed / DDL';
      } else if (node.status === 'Candidate' || node.status === 'In Review') {
        statusClass = 'status-candidate';
      }

      div.innerHTML = \`
        <div class="node-header">
          <span class="node-name">\${escapeHtml(node.displayName || node.name)}</span>
          <span class="node-type-pill">\${escapeHtml(node.type)}</span>
        </div>
        <div class="node-footer">
          <span style="color:#888; font-family:monospace; font-size:0.88em;">\${escapeHtml(node.name)}</span>
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

      const statusBadge = document.getElementById('drawerStatusBadge');
      let statusText = node.status || (node.foundInCollibra ? 'Approved' : 'Not Cataloged');
      let badgeClass = 'status-unregistered';
      if (node.role === 'current_query') {
        badgeClass = 'status-query';
        statusText = node.status || 'Active DDL';
      } else if (node.status === 'Approved') {
        badgeClass = 'status-approved';
      } else if (node.role === 'target' || (node.status && node.status.includes('Proposed'))) {
        badgeClass = 'status-proposed';
        statusText = node.status || 'Proposed / DDL';
      } else if (node.status === 'Candidate' || node.status === 'In Review') {
        badgeClass = 'status-candidate';
      }
      statusBadge.innerText = statusText;
      statusBadge.className = 'status-badge ' + badgeClass;

      const table = document.getElementById('drawerAttrTable');
      table.innerHTML = '';

      if (node.attributes && Object.keys(node.attributes).length > 0) {
        for (const [k, v] of Object.entries(node.attributes)) {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td class="label">\${escapeHtml(k)}:</td>
            <td class="val">\${escapeHtml(String(v))}</td>
          \`;
          table.appendChild(tr);
        }
      } else {
        table.innerHTML = '<tr><td colspan="2" style="color:#888; font-style:italic;">No governance attributes recorded in catalog.</td></tr>';
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
