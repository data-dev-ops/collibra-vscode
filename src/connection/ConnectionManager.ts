import * as vscode from "vscode";
import { CollibraConnection } from "../types";

export class ConnectionManager {
  private static readonly STORAGE_KEY = "collibra.connections";
  private static readonly ACTIVE_KEY = "collibra.activeConnectionId";

  private _onDidChangeActiveConnection = new vscode.EventEmitter<CollibraConnection | null>();
  public readonly onDidChangeActiveConnection = this._onDidChangeActiveConnection.event;

  private _onDidChangeConnections = new vscode.EventEmitter<CollibraConnection[]>();
  public readonly onDidChangeConnections = this._onDidChangeConnections.event;

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {
    this.ensureDefaultConnection();

    // Listen for manual edits in .vscode/settings.json or configuration updates
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (
          e.affectsConfiguration("collibra.connections") ||
          e.affectsConfiguration("collibra.activeConnectionId") ||
          e.affectsConfiguration("collibra.url")
        ) {
          await this.syncFromConfiguration();
        }
      })
    );
  }

  public async syncFromConfiguration(): Promise<void> {
    const connections = await this.getConnections();
    const active = await this.getActiveConnection();
    this._onDidChangeConnections.fire(connections);
    this._onDidChangeActiveConnection.fire(active);
  }

  private getConfigTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  private async ensureDefaultConnection(): Promise<void> {
    const connections = await this.getConnections();
    if (connections.length === 0) {
      const defaultUrl = process.env.COLLIBRA_URL || "http://collibra-service:8080";
      const singleStoreConn: CollibraConnection = {
        id: "conn-singlestore-local",
        name: "SingleStore Jaffle Shop (Local)",
        url: defaultUrl,
        username: "admin",
        password: "password123",
        isDefault: true
      };
      const pagilaConn: CollibraConnection = {
        id: "conn-pagila-local",
        name: "Pagila PostgreSQL (Local)",
        url: defaultUrl,
        username: "admin",
        password: "password123",
        isDefault: false
      };
      await this.saveConnection(singleStoreConn);
      await this.saveConnection(pagilaConn);
      await this.setActiveConnection(singleStoreConn.id);
    }
  }

  public async getConnections(): Promise<CollibraConnection[]> {
    const config = vscode.workspace.getConfiguration("collibra");
    const fromConfig = config.get<CollibraConnection[]>("connections") || [];
    const directUrl = config.get<string>("url");

    let raw: CollibraConnection[] = [];
    if (Array.isArray(fromConfig) && fromConfig.length > 0) {
      raw = [...fromConfig];
    } else {
      raw = this.context.globalState.get<CollibraConnection[]>(ConnectionManager.STORAGE_KEY, []);
    }

    if (raw.length === 0 && directUrl) {
      raw = [{
        id: "conn-direct",
        name: "Collibra (Configured URL)",
        url: directUrl,
        username: "admin",
        password: "password123",
        isDefault: true
      }];
    }

    // Retrieve passwords from secret storage if not provided inline
    const result: CollibraConnection[] = [];
    for (const c of raw) {
      const secret = await this.context.secrets.get(`collibra.secret.${c.id}`);
      result.push({
        ...c,
        password: c.password || secret || ""
      });
    }
    return result;
  }

  public async getActiveConnection(): Promise<CollibraConnection | null> {
    const connections = await this.getConnections();
    if (connections.length === 0) return null;

    const config = vscode.workspace.getConfiguration("collibra");
    const activeId = config.get<string>("activeConnectionId") ||
      this.context.globalState.get<string>(ConnectionManager.ACTIVE_KEY);

    if (activeId) {
      const found = connections.find(c => c.id === activeId);
      if (found) return found;
    }
    return connections[0] || null;
  }

  public async setActiveConnection(id: string): Promise<void> {
    const target = this.getConfigTarget();
    const config = vscode.workspace.getConfiguration("collibra");
    await config.update("activeConnectionId", id, target);
    await this.context.globalState.update(ConnectionManager.ACTIVE_KEY, id);

    const active = await this.getActiveConnection();
    this._onDidChangeActiveConnection.fire(active);
  }

  public async saveConnection(conn: CollibraConnection): Promise<void> {
    const connections = await this.getConnections();
    const index = connections.findIndex(c => c.id === conn.id);

    // Save password securely in SecretStorage as well
    if (conn.password) {
      await this.context.secrets.store(`collibra.secret.${conn.id}`, conn.password);
    }

    let updated: CollibraConnection[];
    if (index >= 0) {
      updated = [...connections];
      updated[index] = conn;
    } else {
      updated = [...connections, conn];
    }

    const target = this.getConfigTarget();
    const config = vscode.workspace.getConfiguration("collibra");
    // Write to settings.json
    await config.update("connections", updated, target);

    // Also sync to globalState for offline fallback
    const stateToSave = updated.map(c => ({ ...c, password: "" }));
    await this.context.globalState.update(ConnectionManager.STORAGE_KEY, stateToSave);

    if (updated.length === 1 || conn.isDefault) {
      await this.setActiveConnection(conn.id);
    }

    this._onDidChangeConnections.fire(updated);
  }

  public async deleteConnection(id: string): Promise<void> {
    const connections = await this.getConnections();
    const updated = connections.filter(c => c.id !== id);

    const target = this.getConfigTarget();
    const config = vscode.workspace.getConfiguration("collibra");
    // Update .vscode/settings.json
    await config.update("connections", updated.length > 0 ? updated : undefined, target);

    // Update globalState
    const stateToSave = updated.map(c => ({ ...c, password: "" }));
    await this.context.globalState.update(ConnectionManager.STORAGE_KEY, stateToSave);
    await this.context.secrets.delete(`collibra.secret.${id}`);

    const activeId = config.get<string>("activeConnectionId") ||
      this.context.globalState.get<string>(ConnectionManager.ACTIVE_KEY);

    if (activeId === id) {
      const nextActive = updated[0]?.id || "";
      await config.update("activeConnectionId", nextActive || undefined, target);
      await this.context.globalState.update(ConnectionManager.ACTIVE_KEY, nextActive);
      this._onDidChangeActiveConnection.fire(updated[0] || null);
    }

    this._onDidChangeConnections.fire(updated);
  }

  public getCandidateUrls(inputUrl: string): string[] {
    const raw = (inputUrl || "http://localhost:8080").trim().replace(/\/+$/, "");
    const candidates: string[] = [];

    if (/collibra-service/.test(raw)) {
      candidates.push(raw.replace("collibra-service", "localhost"));
      candidates.push(raw.replace("collibra-service", "127.0.0.1"));
      candidates.push(raw);
    } else if (/localhost|127\.0\.0\.1/.test(raw)) {
      candidates.push(raw);
      candidates.push(raw.replace(/localhost|127\.0\.0\.1/, "127.0.0.1"));
      candidates.push(raw.replace(/localhost|127\.0\.0\.1/, "collibra-service"));
    } else {
      candidates.push(raw);
    }

    if (process.env.COLLIBRA_URL) {
      candidates.push(process.env.COLLIBRA_URL.trim().replace(/\/+$/, ""));
    }

    return Array.from(new Set(candidates));
  }

  public async testConnection(conn: CollibraConnection): Promise<{ success: boolean; message: string; resolvedUrl?: string }> {
    const candidates = this.getCandidateUrls(conn.url);
    let lastError = "Connection failed";

    for (const testBase of candidates) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        let testUrl = `${testBase}/rest/2.0/assets?limit=1`;
        let res = await fetch(testUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Authorization": "Basic " + Buffer.from(`${conn.username}:${conn.password || ""}`).toString("base64")
          },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
          const note = testBase !== conn.url.replace(/\/+$/, "") ? ` (auto-resolved via ${testBase})` : "";
          return {
            success: true,
            message: `Connected successfully to Collibra${note}!`,
            resolvedUrl: testBase
          };
        }

        // Try /health endpoint as fallback check
        const healthRes = await fetch(`${testBase}/health`, { signal: AbortSignal.timeout(2000) });
        if (healthRes.ok) {
          const note = testBase !== conn.url.replace(/\/+$/, "") ? ` (auto-resolved via ${testBase})` : "";
          return {
            success: true,
            message: `Connected to Collibra service${note} (Health: OK)`,
            resolvedUrl: testBase
          };
        }

        lastError = `HTTP ${res.status}: ${res.statusText}`;
      } catch (err: any) {
        lastError = err.message || String(err);
      }
    }

    return {
      success: false,
      message: `Connection failed: ${lastError}`
    };
  }
}
