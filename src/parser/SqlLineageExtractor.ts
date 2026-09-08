import * as vscode from "vscode";
import { SqlStatementInfo, StatementType } from "../types";

export class SqlLineageExtractor {
  /**
   * Finds the SQL statement at the specified cursor position within a document.
   */
  public static extractStatementAtCursor(
    document: vscode.TextDocument,
    position: vscode.Position,
    defaultSchema = "pagila"
  ): SqlStatementInfo | null {
    const text = document.getText();
    const statements = this.splitSqlStatements(text);

    if (statements.length === 0) {
      return null;
    }

    const cursorOffset = document.offsetAt(position);

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

    return this.analyzeStatement(
      targetStatement.rawSql,
      startPos.line,
      endPos.line,
      defaultSchema
    );
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
          // Escaped quote ''
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

      // Statement delimiter ;
      if (char === ";") {
        const stmtRaw = sqlText.substring(currentStart, i + 1);
        if (stmtRaw.trim().length > 0) {
          // Calculate trim offsets
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
   * Analyzes an isolated SQL statement and extracts:
   * - Statement Type (SELECT, CREATE_TABLE_AS, CREATE_VIEW, ALTER_TABLE, etc.)
   * - Target Objects (tables/views being created or modified)
   * - Source Objects (tables/views referenced in FROM and JOIN clauses)
   */
  public static analyzeStatement(
    rawSql: string,
    startLine: number,
    endLine: number,
    defaultSchema = "pagila"
  ): SqlStatementInfo {
    // Strip comments for clean lexical analysis
    const cleanSql = this.stripComments(rawSql);
    const upper = cleanSql.toUpperCase().trim();

    let statementType: StatementType = "SELECT";
    const targetObjects: string[] = [];
    const sourceObjects: string[] = [];

    // 1. Detect statement type & target objects
    if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i.test(cleanSql)) {
      statementType = "CREATE_VIEW";
      const match = cleanSql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*CREATE\s+(?:TEMPORARY\s+|TEMP\s+)?TABLE/i.test(cleanSql)) {
      statementType = "CREATE_TABLE_AS";
      const match = cleanSql.match(/CREATE\s+(?:TEMPORARY\s+|TEMP\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*ALTER\s+TABLE/i.test(cleanSql)) {
      statementType = "ALTER_TABLE";
      const match = cleanSql.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*INSERT\s+INTO/i.test(cleanSql)) {
      statementType = "INSERT";
      const match = cleanSql.match(/INSERT\s+INTO\s+([a-zA-Z0-9_."]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*UPDATE/i.test(cleanSql)) {
      statementType = "UPDATE";
      const match = cleanSql.match(/UPDATE\s+(?:ONLY\s+)?([a-zA-Z0-9_."]+)/i);
      if (match) {
        targetObjects.push(this.normalizeObjectName(match[1], defaultSchema));
      }
    } else if (/^\s*DELETE\s+FROM/i.test(cleanSql)) {
      statementType = "DELETE";
      const match = cleanSql.match(/DELETE\s+FROM\s+([a-zA-Z0-9_."]+)/i);
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

    // Combine all unique objects
    const allObjects = Array.from(new Set([...targetObjects, ...sourceObjects]));

    return {
      rawSql,
      cleanSql,
      startLine,
      endLine,
      statementType,
      targetObjects,
      sourceObjects,
      allObjects
    };
  }

  /**
   * Extracts table references from FROM, JOIN clauses, handling CTEs and subqueries.
   */
  public static extractSourceTables(cleanSql: string, defaultSchema: string): string[] {
    const sources: string[] = [];

    // Collect CTE names so we don't treat CTE aliases as physical tables
    const cteNames = new Set<string>();
    const cteRegex = /WITH\s+(?:RECURSIVE\s+)?([a-zA-Z0-9_]+)\s+AS\s*\(/gi;
    let cteMatch: RegExpExecArray | null;
    while ((cteMatch = cteRegex.exec(cleanSql)) !== null) {
      cteNames.add(cteMatch[1].toLowerCase());
    }

    // Match FROM clauses up to JOIN, WHERE, GROUP BY, etc.
    // E.g. FROM pagila.film f, pagila.category c
    // E.g. FROM pagila.a a JOIN pagila.b b ON a.id = b.id
    const fromClauseRegex = /\bFROM\s+([\s\S]+?)(?=\b(?:LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|NATURAL\s+JOIN|JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|WINDOW|UNION|INTERSECT|EXCEPT)\b|;|$)/gi;
    let fromMatch: RegExpExecArray | null;
    while ((fromMatch = fromClauseRegex.exec(cleanSql)) !== null) {
      const fromContent = fromMatch[1];
      this.parseTableListFromClause(fromContent, sources, defaultSchema, cteNames);
    }

    // Match JOIN clauses
    // E.g. LEFT JOIN pagila.inventory i ON ...
    const joinRegex = /\b(?:LEFT|RIGHT|FULL|INNER|CROSS|NATURAL)?\s*JOIN\s+([a-zA-Z0-9_."]+)/gi;
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
    // Split by commas, but ignore commas inside parentheses
    const tokens = this.splitTopLevelCommas(clause);
    for (const token of tokens) {
      const trimmed = token.trim();
      // If token starts with parenthesis, it's a subquery: (SELECT ... ) sub
      if (trimmed.startsWith("(")) continue;

      // Extract first identifier: [schema.]table
      const match = trimmed.match(/^([a-zA-Z0-9_."]+)/);
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
    // If not qualified and not a keyword/function, prepend default schema
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
