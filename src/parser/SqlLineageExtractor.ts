import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ColumnInfo, SqlStatementInfo, StatementType } from "../types";

export interface LineageExtractionOptions {
  projectType?: "auto" | "dbt" | "pure sql";
  dwhBackend?: "singlestore" | "postgres" | "mysql";
  defaultSchema?: string;
  dbtTargetPath?: string;
}

interface CachedManifest {
  mtime: number;
  data: any;
}

export class SqlLineageExtractor {
  private static manifestCache = new Map<string, CachedManifest>();

  public static findDbtProjectRoot(filePath: string): string | null {
    let currentDir = path.dirname(filePath);
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(currentDir, "dbt_project.yml"))) {
        return currentDir;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
    return null;
  }

  public static loadDbtManifest(manifestPath: string): any | null {
    try {
      if (!fs.existsSync(manifestPath)) return null;
      const stat = fs.statSync(manifestPath);
      const cached = this.manifestCache.get(manifestPath);
      if (cached && cached.mtime === stat.mtimeMs) {
        return cached.data;
      }
      const raw = fs.readFileSync(manifestPath, "utf8");
      const data = JSON.parse(raw);
      this.manifestCache.set(manifestPath, { mtime: stat.mtimeMs, data });
      return data;
    } catch (err) {
      console.warn("Failed to load dbt manifest:", err);
      return null;
    }
  }

  public static extractFromDbtManifest(
    document: vscode.TextDocument,
    projectRoot: string,
    dwhBackend: string = "singlestore",
    defaultSchema: string = "landing"
  ): SqlStatementInfo {
    const manifestPath = path.join(projectRoot, "target", "manifest.json");
    const rawSql = document.getText();
    const cleanSql = this.stripComments(rawSql);
    const lineCount = document.lineCount || rawSql.split("\n").length;

    if (!fs.existsSync(manifestPath)) {
      return {
        rawSql,
        cleanSql,
        startLine: 0,
        endLine: Math.max(0, lineCount - 1),
        statementType: "DBT_MODEL",
        targetObjects: [],
        sourceObjects: [],
        allObjects: [],
        origin: "dbt_manifest_missing",
        manifestMissing: true,
        projectType: "dbt",
        dialect: dwhBackend as any
      };
    }

    const manifest = this.loadDbtManifest(manifestPath);
    if (!manifest || !manifest.nodes) {
      return {
        rawSql,
        cleanSql,
        startLine: 0,
        endLine: Math.max(0, lineCount - 1),
        statementType: "DBT_MODEL",
        targetObjects: [],
        sourceObjects: [],
        allObjects: [],
        origin: "dbt_manifest_missing",
        manifestMissing: true,
        projectType: "dbt",
        dialect: dwhBackend as any
      };
    }

    const fileName = document.fileName;
    const baseName = path.basename(fileName, ".sql").toLowerCase();
    const relFromRoot = path.relative(projectRoot, fileName).replace(/\\/g, "/");

    // Match node in manifest.nodes
    let matchedNodeKey: string | null = null;
    for (const [key, node] of Object.entries<any>(manifest.nodes)) {
      if (node.resource_type !== "model") continue;
      const origPath = (node.original_file_path || "").replace(/\\/g, "/");
      const nodePath = (node.path || "").replace(/\\/g, "/");
      if (
        origPath === relFromRoot ||
        origPath.endsWith(relFromRoot) ||
        nodePath === relFromRoot ||
        node.name?.toLowerCase() === baseName
      ) {
        matchedNodeKey = key;
        break;
      }
    }

    if (!matchedNodeKey) {
      return {
        rawSql,
        cleanSql,
        startLine: 0,
        endLine: Math.max(0, lineCount - 1),
        statementType: "DBT_MODEL",
        targetObjects: [],
        sourceObjects: [],
        allObjects: [],
        origin: "dbt_manifest_missing",
        manifestMissing: true,
        projectType: "dbt",
        dialect: dwhBackend as any
      };
    }

    const node = manifest.nodes[matchedNodeKey];
    const database = node.database || defaultSchema;
    const schema = node.schema || defaultSchema;
    const alias = node.alias || node.name || baseName;
    const targetName = `${schema}.${alias}`;

    const sourceObjects: string[] = [];
    const columnMetadataMap: Record<string, ColumnInfo[]> = {};

    const mapCols = (colsObj: any): ColumnInfo[] => {
      if (!colsObj || typeof colsObj !== "object") return [];
      return Object.values<any>(colsObj).map(c => ({
        name: c.name,
        dataType: c.data_type,
        description: c.description
      }));
    };

    columnMetadataMap[targetName] = mapCols(node.columns);

    // Resolve depends_on.nodes
    const depNodes = node.depends_on?.nodes || [];
    for (const depId of depNodes) {
      if (typeof depId !== "string") continue;
      if (depId.startsWith("model.") && manifest.nodes[depId]) {
        const parent = manifest.nodes[depId];
        const pSchema = parent.schema || defaultSchema;
        const pAlias = parent.alias || parent.name;
        const pName = `${pSchema}.${pAlias}`;
        if (!sourceObjects.includes(pName)) {
          sourceObjects.push(pName);
        }
        columnMetadataMap[pName] = mapCols(parent.columns);
      } else if (depId.startsWith("source.") && manifest.sources && manifest.sources[depId]) {
        const src = manifest.sources[depId];
        const sSchema = src.schema || src.source_name || defaultSchema;
        const sName = src.identifier || src.name;
        const fullSrcName = `${sSchema}.${sName}`;
        if (!sourceObjects.includes(fullSrcName)) {
          sourceObjects.push(fullSrcName);
        }
        columnMetadataMap[fullSrcName] = mapCols(src.columns);
      }
    }

    const compiledSql = node.compiled_code || node.raw_code || rawSql;
    const targetObjects = [targetName];
    const allObjects = Array.from(new Set([targetName, ...sourceObjects]));

    return {
      rawSql: node.raw_code || rawSql,
      cleanSql: this.stripComments(compiledSql),
      startLine: 0,
      endLine: Math.max(0, lineCount - 1),
      statementType: "DBT_MODEL",
      targetObjects,
      sourceObjects,
      allObjects,
      origin: "dbt_manifest",
      resolvedFilePath: manifestPath,
      projectType: "dbt",
      dialect: dwhBackend as any,
      manifestMissing: false,
      manifestDetails: {
        database,
        schema,
        name: node.name,
        alias,
        uniqueId: node.unique_id
      },
      columnMetadataMap
    };
  }

  /**
   * Finds and analyzes the SQL statement based on project type and cursor position.
   * In dbt mode, resolves the exact database, schema, alias and dependencies from target/manifest.json.
   */
  public static extractStatementAtCursor(
    document: vscode.TextDocument,
    position?: vscode.Position,
    defaultSchema = "pagila",
    options?: LineageExtractionOptions
  ): SqlStatementInfo | null {
    const projectTypeSetting = options?.projectType || "auto";
    const dwhBackend = options?.dwhBackend || "singlestore";
    const targetFolder = options?.dbtTargetPath || "target/compiled";
    const effectiveSchema = options?.defaultSchema || (dwhBackend === "singlestore" ? "landing" : defaultSchema);

    // 1. Determine if this file should be handled as a dbt model
    const isDbt = this.isDbtDocument(document, projectTypeSetting);

    if (isDbt) {
      const projectRoot = this.findDbtProjectRoot(document.fileName);
      if (projectRoot) {
        return this.extractFromDbtManifest(document, projectRoot, dwhBackend, effectiveSchema);
      }

      // Fallback: Check matching compiled SQL file from target directory
      const compiledTargetFile = this.resolveDbtTargetFile(document.fileName, targetFolder);
      if (compiledTargetFile && fs.existsSync(compiledTargetFile)) {
        try {
          const compiledSql = fs.readFileSync(compiledTargetFile, "utf8");
          const lineCount = compiledSql.split("\n").length;
          const analyzed = this.analyzeStatement(
            compiledSql,
            0,
            lineCount - 1,
            effectiveSchema,
            dwhBackend
          );

          if (analyzed.targetObjects.length === 0) {
            const inferredTarget = this.inferDbtModelTarget(document.fileName, effectiveSchema);
            analyzed.targetObjects.push(inferredTarget);
            if (!analyzed.allObjects.includes(inferredTarget)) {
              analyzed.allObjects.unshift(inferredTarget);
            }
            analyzed.statementType = "DBT_MODEL";
          }

          analyzed.origin = "dbt_target";
          analyzed.resolvedFilePath = compiledTargetFile;
          analyzed.projectType = "dbt";
          analyzed.dialect = dwhBackend;
          return analyzed;
        } catch (err) {
          console.warn(`Error reading dbt compiled target file ${compiledTargetFile}:`, err);
        }
      }

      // If neither manifest nor compiled target exists, report manifest missing
      return {
        rawSql: document.getText(),
        cleanSql: this.stripComments(document.getText()),
        startLine: 0,
        endLine: Math.max(0, (document.lineCount || 1) - 1),
        statementType: "DBT_MODEL",
        targetObjects: [],
        sourceObjects: [],
        allObjects: [],
        origin: "dbt_manifest_missing",
        manifestMissing: true,
        projectType: "dbt",
        dialect: dwhBackend as any
      };
    }

    // 2. Pure SQL Mode: extract statement at cursor position
    const text = document.getText();
    const statements = this.splitSqlStatements(text);

    if (statements.length === 0) {
      return null;
    }

    const cursorOffset = position ? document.offsetAt(position) : 0;

    // Find the statement enclosing the cursor
    let targetStatement = statements.find(
      s => cursorOffset >= s.startOffset && cursorOffset <= s.endOffset
    );

    // If cursor is at whitespace or trailing boundary, pick closest preceding statement
    if (!targetStatement) {
      const preceding = statements.filter(s => s.endOffset <= cursorOffset);
      if (preceding.length > 0) {
        targetStatement = preceding[preceding.length - 1];
      } else {
        targetStatement = statements[0];
      }
    }

    if (!targetStatement) {
      return null;
    }

    const startPos = document.positionAt(targetStatement.startOffset);
    const endPos = document.positionAt(targetStatement.endOffset);

    const analyzed = this.analyzeStatement(
      targetStatement.rawSql,
      startPos.line,
      endPos.line,
      effectiveSchema,
      dwhBackend
    );

    analyzed.origin = "active_file";
    analyzed.projectType = "pure sql";
    analyzed.dialect = dwhBackend;
    return analyzed;
  }

  /**
   * Determines whether the given document is a dbt model.
   */
  public static isDbtDocument(
    document: vscode.TextDocument,
    projectType: "auto" | "dbt" | "pure sql" = "auto"
  ): boolean {
    if (projectType === "pure sql") return false;
    if (projectType === "dbt") return true;

    // Auto-detection
    const root = this.findDbtProjectRoot(document.fileName);
    if (root) return true;

    const filePath = document.fileName;
    if (filePath.includes(`${path.sep}models${path.sep}`) || filePath.endsWith(".sql")) {
      const text = document.getText();
      return /\{\{\s*(ref|source|config)\b/i.test(text);
    }

    return false;
  }

  /**
   * Resolves the matching pre-compiled file from the dbt target directory.
   */
  public static resolveDbtTargetFile(
    sourceFilePath: string,
    targetFolder = "target/compiled"
  ): string | null {
    const modelsIndex = sourceFilePath.indexOf(`${path.sep}models${path.sep}`);
    if (modelsIndex === -1) {
      return null;
    }

    const projectRoot = sourceFilePath.substring(0, modelsIndex);
    const relFromModels = sourceFilePath.substring(modelsIndex + 8); // e.g. "marts/customers.sql"

    // Read dbt project name
    let projectName = "";
    const dbtProjectFile = path.join(projectRoot, "dbt_project.yml");
    if (fs.existsSync(dbtProjectFile)) {
      try {
        const yml = fs.readFileSync(dbtProjectFile, "utf8");
        const match = yml.match(/^name:\s*['"]?([a-zA-Z0-9_-]+)['"]?/m);
        if (match) {
          projectName = match[1];
        }
      } catch (e) {}
    }

    // Candidate 1: <root>/target/compiled/<projectName>/models/<relPath>
    if (projectName) {
      const cand1 = path.join(projectRoot, targetFolder, projectName, "models", relFromModels);
      if (fs.existsSync(cand1)) return cand1;
    }

    // Candidate 2: <root>/target/compiled/models/<relPath>
    const cand2 = path.join(projectRoot, targetFolder, "models", relFromModels);
    if (fs.existsSync(cand2)) return cand2;

    // Candidate 3: recursive search by filename inside target directory
    const targetDir = path.join(projectRoot, targetFolder);
    const baseName = path.basename(sourceFilePath);
    const found = this.findFileRecursive(targetDir, baseName);
    if (found) return found;

    return null;
  }

  private static findFileRecursive(dir: string, targetName: string): string | null {
    if (!fs.existsSync(dir)) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const sub = this.findFileRecursive(fullPath, targetName);
          if (sub) return sub;
        } else if (entry.name === targetName) {
          return fullPath;
        }
      }
    } catch (e) {}
    return null;
  }

  /**
   * Fallback AST parser extracting ref() and source() dependencies directly from uncompiled Jinja SQL.
   */
  public static extractDbtJinjaStatement(
    rawSql: string,
    fileName: string,
    defaultSchema = "landing",
    dwhBackend = "singlestore"
  ): SqlStatementInfo {
    const cleanSql = this.stripComments(rawSql);
    const sourceObjects: string[] = [];
    const targetObjects: string[] = [];

    // Extract {{ ref('model_name') }}
    const refRegex = /\{\{\s*ref\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/gi;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRegex.exec(cleanSql)) !== null) {
      const rawRef = refMatch[1].trim();
      const normalized = this.normalizeDbtRef(rawRef, defaultSchema);
      if (!sourceObjects.includes(normalized)) {
        sourceObjects.push(normalized);
      }
    }

    // Extract {{ source('source_name', 'table_name') }}
    const sourceRegex = /\{\{\s*source\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/gi;
    let srcMatch: RegExpExecArray | null;
    while ((srcMatch = sourceRegex.exec(cleanSql)) !== null) {
      const srcName = `${srcMatch[1].trim()}.${srcMatch[2].trim()}`.toLowerCase();
      if (!sourceObjects.includes(srcName)) {
        sourceObjects.push(srcName);
      }
    }

    // Determine target object from file path
    const inferredTarget = this.inferDbtModelTarget(fileName, defaultSchema);
    targetObjects.push(inferredTarget);

    const allObjects = Array.from(new Set([...targetObjects, ...sourceObjects]));

    return {
      rawSql,
      cleanSql,
      startLine: 0,
      endLine: rawSql.split("\n").length - 1,
      statementType: "DBT_MODEL",
      targetObjects,
      sourceObjects,
      allObjects,
      origin: "dbt_jinja_fallback",
      projectType: "dbt",
      dialect: dwhBackend as any
    };
  }

  private static normalizeDbtRef(refName: string, defaultSchema: string): string {
    const lower = refName.toLowerCase().trim();
    if (lower.startsWith("stg_")) {
      return `staging.${lower}`;
    }
    if (lower.startsWith("fct_") || lower.startsWith("dim_") || lower === "customers" || lower === "orders") {
      return `presentation.${lower}`;
    }
    return lower.includes(".") ? lower : `${defaultSchema}.${lower}`;
  }

  private static inferDbtModelTarget(fileName: string, defaultSchema: string): string {
    const baseName = path.basename(fileName, ".sql").toLowerCase();
    if (fileName.includes(`${path.sep}staging${path.sep}`) || baseName.startsWith("stg_")) {
      return `staging.${baseName}`;
    }
    if (fileName.includes(`${path.sep}marts${path.sep}`) || fileName.includes(`${path.sep}presentation${path.sep}`)) {
      return `presentation.${baseName}`;
    }
    return `${defaultSchema}.${baseName}`;
  }

  /**
   * Splits a multi-statement SQL script into individual statements taking into account
   * single-quoted strings, double-quoted identifiers, and comments.
   */
  public static splitSqlStatements(
    sqlText: string
  ): Array<{ rawSql: string; startOffset: number; endOffset: number }> {
    const results: Array<{ rawSql: string; startOffset: number; endOffset: number }> = [];

    let currentStart = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let inLineComment = false;
    let inBlockComment = false;

    const len = sqlText.length;

    for (let i = 0; i < len; i++) {
      const char = sqlText[i];
      const nextChar = i + 1 < len ? sqlText[i + 1] : "";

      if (inLineComment) {
        if (char === "\n") inLineComment = false;
        continue;
      }

      if (inBlockComment) {
        if (char === "*" && nextChar === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (inSingleQuote) {
        if (char === "'") {
          if (nextChar === "'") {
            i++;
          } else {
            inSingleQuote = false;
          }
        }
        continue;
      }

      if (inDoubleQuote) {
        if (char === '"') {
          inDoubleQuote = false;
        }
        continue;
      }

      if (inBacktick) {
        if (char === "`") {
          inBacktick = false;
        }
        continue;
      }

      // Check comments
      if (char === "-" && nextChar === "-") {
        inLineComment = true;
        i++;
        continue;
      }
      if (char === "/" && nextChar === "*") {
        inBlockComment = true;
        i++;
        continue;
      }

      // Check quotes
      if (char === "'") {
        inSingleQuote = true;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        continue;
      }
      if (char === "`") {
        inBacktick = true;
        continue;
      }

      // Statement delimiter ;
      if (char === ";") {
        const stmtRaw = sqlText.substring(currentStart, i + 1);
        if (stmtRaw.trim().length > 0) {
          const trimmed = stmtRaw.trim();
          const leadingOffset = stmtRaw.indexOf(trimmed[0]);
          results.push({
            rawSql: trimmed,
            startOffset: currentStart + leadingOffset,
            endOffset: i + 1
          });
        }
        currentStart = i + 1;
      }
    }

    // Trailing statement without semicolon
    if (currentStart < len) {
      const stmtRaw = sqlText.substring(currentStart, len);
      if (stmtRaw.trim().length > 0) {
        const trimmed = stmtRaw.trim();
        const leadingOffset = stmtRaw.indexOf(trimmed[0]);
        results.push({
          rawSql: trimmed,
          startOffset: currentStart + leadingOffset,
          endOffset: len
        });
      }
    }

    return results;
  }

  /**
   * Analyzes an isolated SQL statement and extracts statement type, targets, and sources.
   * Supports SingleStore / MySQL (backticks, rowstore/columnstore) and PostgreSQL dialects.
   */
  public static analyzeStatement(
    rawSql: string,
    startLine: number,
    endLine: number,
    defaultSchema = "pagila",
    dwhBackend = "singlestore"
  ): SqlStatementInfo {
    const cleanSql = this.stripComments(rawSql);
    const upper = cleanSql.toUpperCase().trim();

    let statementType: StatementType = "SELECT";
    const targetObjects: string[] = [];
    const sourceObjects: string[] = [];

    // 1. Detect statement type & target objects
    if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i.test(cleanSql)) {
      statementType = "CREATE_VIEW";
      const match = cleanSql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."`]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*CREATE\s+(?:ROWSTORE\s+|COLUMNSTORE\s+|REFERENCE\s+|TEMPORARY\s+|TEMP\s+)?TABLE/i.test(cleanSql)) {
      statementType = "CREATE_TABLE_AS";
      const match = cleanSql.match(/CREATE\s+(?:ROWSTORE\s+|COLUMNSTORE\s+|REFERENCE\s+|TEMPORARY\s+|TEMP\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."`]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*ALTER\s+TABLE/i.test(cleanSql)) {
      statementType = "ALTER_TABLE";
      const match = cleanSql.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."`]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*INSERT\s+INTO/i.test(cleanSql)) {
      statementType = "INSERT";
      const match = cleanSql.match(/INSERT\s+INTO\s+([a-zA-Z0-9_."`]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*UPDATE/i.test(cleanSql)) {
      statementType = "UPDATE";
      const match = cleanSql.match(/UPDATE\s+(?:ONLY\s+)?([a-zA-Z0-9_."`]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*DELETE\s+FROM/i.test(cleanSql)) {
      statementType = "DELETE";
      const match = cleanSql.match(/DELETE\s+FROM\s+([a-zA-Z0-9_."`]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*(?:WITH\b|SELECT\b)/i.test(cleanSql)) {
      statementType = "SELECT";
    } else {
      statementType = "OTHER";
    }

    // 2. Extract Source Tables (FROM and JOIN)
    const extractedSources = this.extractSourceTables(cleanSql, defaultSchema);
    for (const src of extractedSources) {
      if (!sourceObjects.includes(src) && !targetObjects.includes(src)) {
        sourceObjects.push(src);
      }
    }

    const allObjects = Array.from(new Set([...targetObjects, ...sourceObjects]));

    return {
      rawSql,
      cleanSql,
      startLine,
      endLine,
      statementType,
      targetObjects,
      sourceObjects,
      allObjects,
      dialect: dwhBackend as any
    };
  }

  /**
   * Extracts table references from FROM and JOIN clauses, handling CTEs and subqueries.
   */
  public static extractSourceTables(cleanSql: string, defaultSchema: string): string[] {
    const sources: string[] = [];

    // Collect CTE names so we don't treat CTE aliases as physical tables
    const cteNames = new Set<string>();
    const cteRegex = /(?:WITH|,)\s+([a-zA-Z0-9_]+)\s+AS\s*\(/gi;
    let cteMatch: RegExpExecArray | null;
    while ((cteMatch = cteRegex.exec(cleanSql)) !== null) {
      cteNames.add(cteMatch[1].toLowerCase());
    }

    // Match FROM clauses up to JOIN, WHERE, GROUP BY, etc.
    const fromClauseRegex = /\bFROM\s+([\s\S]+?)(?=\b(?:LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|NATURAL\s+JOIN|JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|WINDOW|UNION|INTERSECT|EXCEPT)\b|;|$)/gi;
    let fromMatch: RegExpExecArray | null;
    while ((fromMatch = fromClauseRegex.exec(cleanSql)) !== null) {
      const fromContent = fromMatch[1];
      this.parseTableListFromClause(fromContent, sources, defaultSchema, cteNames);
    }

    // Match JOIN clauses
    const joinRegex = /\b(?:LEFT|RIGHT|FULL|INNER|CROSS|NATURAL)?\s*JOIN\s+([a-zA-Z0-9_."`]+)/gi;
    let joinMatch: RegExpExecArray | null;
    while ((joinMatch = joinRegex.exec(cleanSql)) !== null) {
      const tableCandidate = joinMatch[1];
      const normalized = this.normalizeObjectName(tableCandidate, defaultSchema);
      const pureName = this.stripQuotes(tableCandidate).toLowerCase();
      if (!cteNames.has(pureName) && !sources.includes(normalized)) {
        sources.push(normalized);
      }
    }

    return sources;
  }

  private static parseTableListFromClause(
    clause: string,
    sources: string[],
    defaultSchema: string,
    cteNames: Set<string>
  ) {
    const tokens = this.splitTopLevelCommas(clause);
    for (const token of tokens) {
      const trimmed = token.trim();
      if (trimmed.startsWith("(")) continue;

      const match = trimmed.match(/^([a-zA-Z0-9_."`]+)/);
      if (match) {
        const candidate = match[1];
        const pureName = this.stripQuotes(candidate).toLowerCase();
        if (!cteNames.has(pureName)) {
          const normalized = this.normalizeObjectName(candidate, defaultSchema);
          if (!sources.includes(normalized)) {
            sources.push(normalized);
          }
        }
      }
    }
  }

  private static splitTopLevelCommas(str: string): string[] {
    const parts: string[] = [];
    let parenDepth = 0;
    let lastIdx = 0;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      else if (ch === "," && parenDepth === 0) {
        parts.push(str.substring(lastIdx, i));
        lastIdx = i + 1;
      }
    }
    if (lastIdx < str.length) {
      parts.push(str.substring(lastIdx));
    }
    return parts;
  }

  public static normalizeObjectName(name: string, defaultSchema = "pagila"): string {
    const clean = this.stripQuotes(name.trim());
    if (clean.includes(".")) {
      return clean.toLowerCase();
    }
    return `${defaultSchema}.${clean}`.toLowerCase();
  }

  public static stripQuotes(str: string): string {
    return str.replace(/["`]/g, "");
  }

  public static stripComments(sql: string): string {
    return sql
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  }
}
