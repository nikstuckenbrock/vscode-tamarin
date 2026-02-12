import * as fs from "fs";
import * as path from "path";
import * as Parser from "web-tree-sitter";
import { createSymbolTable, TamarinSymbolTable } from "./symbol_table/create_symbol_table";
import { Diagnostic, Position, Location, WorkspaceEdit, TextEdit } from "vscode-languageserver-types";
import { TextDocument } from "vscode-languageserver-textdocument";
import { detect_errors } from "./features/syntax_errors";
import { checks_with_table } from "./features/checks";
import { DeclarationType, TamarinSymbol } from "./symbol_table/tamarinTypes";

export class DependencyAnalyzer {
    private symbolTable: Map<string, TamarinSymbolTable>;
    private reverseIncludes: Map<string, string[]>;
    private spthyParser: Parser | undefined;
    private splibParser: Parser | undefined;

    constructor() {
        this.symbolTable = new Map<string, TamarinSymbolTable>();
        this.reverseIncludes = new Map<string, string[]>();
    }

    public async initParsers(SpthyParserPath: string, SplibParserPath: string): Promise<void> {
        await Parser.init();

        this.spthyParser = new Parser();
        const spthyLang = await Parser.Language.load(SpthyParserPath);
        this.spthyParser.setLanguage(spthyLang);
        console.log("SPTHY Parser initialized with Tamarin language.");

        this.splibParser = new Parser();
        const splibLang = await Parser.Language.load(SplibParserPath);
        this.splibParser.setLanguage(splibLang);
        console.log("SPLIB Parser initialized with Tamarin language.");
    }

    /**
     * Analyzes all files in the given root directory.
     * This means building a dependency graph and global symbol table.
     * These objects are then used to do further checks.
     * @param root The root directory of the workspace.
     */
    public async analyzeWorkspace(root: string) {
        const files = await DependencyAnalyzer.getAllTamarinFiles(root);
        for (const file of files) {
            const content = fs.readFileSync(file, "utf-8");
            const doc = TextDocument.create("file://".concat(file), 'tamarin', 1, content);
            await this.analyzeFile(doc);
        }

        for (const [file, table] of this.symbolTable.entries()) {
            for (const included of table.getRelativeIncludePaths(file)) {
                if (!this.reverseIncludes.has(included)) this.reverseIncludes.set(included, []);
                this.reverseIncludes.get(included)!.push(file);
            }
        }
    }

    /**
     * Checks the given document and returns all diagnoses for it
     * @param document The document to check
     * @returns A list of diagnoses
     */
    public async diagnoseDocument(document: TextDocument): Promise<Diagnostic[]> {
        const { tree, symbolTable, diags } = await this.analyzeFile(document);
        const { diagnostics: syntaxDiagnostics } = await detect_errors(tree.rootNode, document);
        const wellformednessDiagnostics = await checks_with_table(symbolTable, document, tree.rootNode, this.symbolTable, this);
        const allDiagnostics = [
            ...syntaxDiagnostics,
            ...diags,
            ...wellformednessDiagnostics,

        ]
        return allDiagnostics
    }

    public findRoot(file: string): string {
        const visited = new Set<string>();
        let current = file;
        while (!visited.has(current)) {
            visited.add(current);
            const parents = this.reverseIncludes.get(current) ?? [];
            if (parents.length === 0) {
                return current
            }
            current = parents[0];
        }
        return current;
    }

    public findSymbolsForRoot(root: string): TamarinSymbol[] {
        const visited = new Set<string>();

        const dfs = (file: string): TamarinSymbol[] => {
            if (visited.has(file)) return [];
            visited.add(file);

            const table = this.symbolTable.get(file);
            if (!table) return [];

            return [
                ...table.getSymbols(),
                ...table.getRelativeIncludePaths(file).flatMap(dfs)
            ];
        };

        return dfs(root);
    }

    public getDefinition(document: TextDocument, position: Position): Location[] {
        if (!this.spthyParser) {
            throw new Error("Parser not initialized");
        }
        const table = this.symbolTable.get(document.uri);
        if (!table) {
            console.error(`No symbol table found for document: ${document.uri}`);
            return [];
        }
        const tree = this.spthyParser.parse(document.getText());
        const point = { row: position.line, column: position.character };
        const nodeAtcursor = tree.rootNode.descendantForPosition(point);
        if (!nodeAtcursor) {
            console.error(`No node found at position: ${point.row}, ${point.column}`);
            return [];
        }
        const symbolName = nodeAtcursor.text;
        const symbol = table.getSymbols().find(sym => sym.name === symbolName);

        if (symbol && symbol.name_range) {
            const location: Location = {
                uri: document.uri,
                range: symbol.name_range

            };
            return [location]
        }
        return [];
    }

    public handleRenameRequest(document: TextDocument, position: Position, newName: string): WorkspaceEdit | null {
        const table = this.symbolTable.get(document.uri);
        if (!table) return null
        if (!this.spthyParser) {
            throw new Error("Parser not initialized");
        }
        const tree = this.spthyParser.parse(document.getText());
        const point = { row: position.line, column: position.character };
        const nodeAtCursor = tree.rootNode.descendantForPosition(point);
        if (!nodeAtCursor) {
            return null;
        }
        const oldname = tree.rootNode.namedDescendantForPosition(point).text;
        const originalSymbol = table.getSymbols().find(symbol =>
            symbol.name === oldname &&
            symbol.name_range &&
            symbol.name_range.start.line === position.line &&
            symbol.name_range.start.character === position.character
        );
        if (!originalSymbol) return null;
        const edits: TextEdit[] = [];
        const chosenSymbolName = originalSymbol.name;
        for (const symbol of table.getSymbols()) {
            let shouldRename = false;
            if (symbol.declaration === DeclarationType.PRVariable ||
                symbol.declaration === DeclarationType.ActionFVariable ||
                symbol.declaration === DeclarationType.CCLVariable
            ) {
                if (originalSymbol.context === symbol.context && chosenSymbolName === symbol.name) {
                    shouldRename = true;
                }
            }
            else if (symbol.declaration === DeclarationType.LemmaVariable) {
                if (symbol.associated_qf?.id === originalSymbol.associated_qf?.id && symbol.name === chosenSymbolName) {
                    shouldRename = true;
                }
            }
            else if (symbol.declaration === DeclarationType.LEquationVariable ||
                symbol.declaration === DeclarationType.REquationVariable ||
                symbol.declaration === DeclarationType.LMacroVariable ||
                symbol.declaration === DeclarationType.RMacroVariable) {
                if (originalSymbol.context.id === symbol.context.id && chosenSymbolName === symbol.name) {
                    shouldRename = true;
                }
            }
            else if (symbol.name === chosenSymbolName && symbol.declaration === originalSymbol.declaration) {
                shouldRename = true;
            }
            if (shouldRename) {
                if (symbol.name_range) {
                    edits.push(TextEdit.replace(symbol.name_range, newName));
                }
            }
        }
        if (edits.length === 0) {
            return null;
        }
        const workspaceEdit: WorkspaceEdit = {
            changes: {
                [document.uri]: edits
            }
        };
        return workspaceEdit;
    }

    public handleDocumentClose(uri: string): void {
        console.log(`Document closed: ${uri}. Cleaning up symbol table.`);
        this.symbolTable.delete(uri);
    }

    /**
     * Analyzes the given file and returns diagnostics
     * @param doc The document to analyze
     * @returns The parsed tree, symbol table and document related diagnostics
     */
    private async analyzeFile(doc: TextDocument): Promise<{ tree: Parser.Tree; symbolTable: TamarinSymbolTable; diags: Diagnostic[] }> {
        const tree = this.splibParser?.parse(doc.getText());
        if (!tree) {
            throw new Error(``);
        }
        const { symbolTable, diags } = await createSymbolTable(tree.rootNode, doc);
        this.symbolTable.set(doc.uri, symbolTable);
        return { tree, symbolTable, diags };
    }

    /**
     * Finds all relevant Tamarin files in the given directory.
     * @param root The root directory to search from.
     * @returns All relevant Tamarin files in the given directory.
     */
    private static async getAllTamarinFiles(root: string): Promise<string[]> {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        const files = await Promise.all(entries.map(entry => {
            const res = path.resolve(root, entry.name);
            if (entry.isDirectory()) {
                return this.getAllTamarinFiles(res);
            } else if (entry.isFile() && (res.endsWith(".spthy") || res.endsWith(".splib"))) {
                return [res];
            } else {
                return [];
            }
        }));
        return files.flat();
    }
}