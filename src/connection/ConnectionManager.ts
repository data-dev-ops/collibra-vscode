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
  }

  private async ensureDefaultConnection(): Promise<void> {
    const connections = await this.getConnections();
    if (connections.length === 0) {
      // Determine probable host: if running in devcontainer, collibra-service or localhost
      const defaultConn: CollibraConnection = {
        id: "conn-pagila-local",
        name: "Pagila Collibra Service (Local)",
        url: "http://localhost:8080",
        username: "admin",
        password: "password123",
        isDefault: true
      };
      await this.saveConnection(defaultConn);
      await this.setActiveConnection(defaultConn.id);
    }
  }

  public async getConnections(): Promise<CollibraConnection[]> {
    const raw = this.context.globalState.get<CollibraConnection[]>(ConnectionManager.STORAGE_KEY, []);
    // Retrieve passwords from secret storage if available
    const result: CollibraConnection[] = [];
    for (const c of raw) {
      const secret = await this.context.secrets.get(`collibra.secret.${c.id}`);
      result.push({
        ...c,
        password: secret || c.password || ""
      });
    }
    return result;
  }

  public async getActiveConnection(): Promise<CollibraConnection | null> {
    const connections = await this.getConnections();
    const activeId = this.context.globalState.get<string>(ConnectionManager.ACTIVE_KEY);
    if (activeId) {
      const found = connections.find(c => c.id === activeId);
      if (found) return found;
    }
    return connections[0] || null;
  }

  public async setActiveConnection(id: string): Promise<void> {
    await this.context.globalState.update(ConnectionManager.ACTIVE_KEY, id);
    const active = await this.getActiveConnection();
    this._onDidChangeActiveConnection.fire(active);
  }

  public async saveConnection(conn: CollibraConnection): Promise<void> {
    const connections = await this.getConnections();
    const index = connections.findIndex(c => c.id === conn.id);

    // Save password securely
    if (conn.password) {
      await this.context.secrets.store(`collibra.secret.${conn.id}`, conn.password);
    }

    // Clone without password in globalState for safety
    const safeConn = { ...conn, password: "" };

    let updated: CollibraConnection[];
    if (index >= 0) {
      updated = [...connections];
      updated[index] = conn;
    } else {
      updated = [...connections, conn];
    }

    const stateToSave = updated.map(c => ({ ...c, password: "" }));
    await this.context.globalState.update(ConnectionManager.STORAGE_KEY, stateToSave);
    this._onDidChangeConnections.fire(updated);

    // If only 1 connection or marked default, set active
    if (updated.length === 1 || conn.isDefault) {
      await this.setActiveConnection(conn.id);
    }
  }

  public async deleteConnection(id: string): Promise<void> {
    const connections = await this.getConnections();
    const updated = connections.filter(c => c.id !== id);
    const stateToSave = updated.map(c => ({ ...c, password: "" }));
    await this.context.globalState.update(ConnectionManager.STORAGE_KEY, stateToSave);
    await this.context.secrets.delete(`collibra.secret.${id}`);

    const activeId = this.context.globalState.get<string>(ConnectionManager.ACTIVE_KEY);
    if (activeId === id) {
      const nextActive = updated[0]?.id || "";
      await this.context.globalState.update(ConnectionManager.ACTIVE_KEY, nextActive);
      this._onDidChangeActiveConnection.fire(updated[0] || null);
    }
    this._onDidChangeConnections.fire(updated);
  }

  public async testConnection(conn: CollibraConnection): Promise<{ success: boolean; message: string; details?: any }> {
    try {
      const baseUrl = conn.url.replace(/\/+$/, "");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      // Try /health or /rest/2.0/assets
      let testUrl = `${baseUrl}/rest/2.0/assets?limit=1`;
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
        return {
          success: true,
          message: `Connected successfully to Collibra (${baseUrl})!`
        };
      }

      // If 404 on assets, try /health
      const healthRes = await fetch(`${baseUrl}/health`);
      if (healthRes.ok) {
        return {
          success: true,
          message: `Connected to Collibra service at ${baseUrl} (Health: OK)`
        };
      }

      return {
        success: false,
        message: `Collibra responded with HTTP status ${res.status}: ${res.statusText}`
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Connection failed: ${err.message || String(err)}`
      };
    }
  }
}
