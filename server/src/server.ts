import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    createConnection,
    ProposedFeatures,
    TextDocuments,
    InitializeParams,
    ServerCapabilities,
    TextDocumentSyncKind,
    DefinitionParams,
    RenameParams,
    WorkspaceEdit
} from 'vscode-languageserver/node';

import { DependencyAnalyzer } from './dependencyAnalyzer';


console.error('[Server] Tamarin Language Server starting...');
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let dependencyAnalyzer: DependencyAnalyzer;

connection.onInitialize(async (params: InitializeParams) => {
    const SpthyParserPath = params.initializationOptions.SpthyParserPath;
    const SplibParserPath = params.initializationOptions.SplibParserPath;
    dependencyAnalyzer = new DependencyAnalyzer();
    await dependencyAnalyzer.initParsers(SpthyParserPath, SplibParserPath);
    console.error('[Server] Received "initialize" request from client.');
    const capabilities: ServerCapabilities = {
        textDocumentSync: TextDocumentSyncKind.Full,
        definitionProvider: true,
        renameProvider: true,
    };
    console.error('[Server] Sending server capabilities back.');
    return { capabilities };
});

connection.onInitialized(async () => {
    console.error('[Server] Received "initialized" notification. Handshake complete!');

    const workspaceFolders = await connection.workspace.getWorkspaceFolders();
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const rootPath = workspaceFolders[0].uri.replace("file://", "");
    console.log("Workspace root:", rootPath);

    await dependencyAnalyzer.analyzeWorkspace(rootPath, documents.all());
});

documents.onDidChangeContent(async (change) => {
    console.error(`[Server] File changed: ${change.document.uri}. Triggering validation.`);
    const diagnostics = await dependencyAnalyzer.diagnoseDocument(change.document);

    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
    console.error(`[Server] Diagnostics sent for ${change.document.uri}.`);
});

connection.onDefinition((params: DefinitionParams) => {
    if (!dependencyAnalyzer) return null;
    console.error(`[Server] Received 'onDefinition' request for ${params.textDocument.uri}.`);
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        console.error(`[Server] Document not found: ${params.textDocument.uri}`);
        return null;
    }
    return dependencyAnalyzer.getDefinition(document, params.position);
}
);

connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
    if (!dependencyAnalyzer) {
        return null;
    }
    console.error(`[Server] Received 'onRenameRequest' for ${params.textDocument.uri} at position ${params.position.line}:${params.position.character}.`);
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        console.error(`[Server] Document not found: ${params.textDocument.uri}`);
        return null;
    }
    return dependencyAnalyzer.handleRenameRequest(document, params.position, params.newName)
});

documents.onDidOpen(event => {
    console.error(`[Server] Document opened: ${event.document.uri}. Starting analysis.`);
    if (dependencyAnalyzer) {
        dependencyAnalyzer.diagnoseDocument(event.document);
    }
});

documents.onDidClose(event => {
    console.error(`[Server] Document closed: ${event.document.uri}. Cleaning up state.`);
    if (dependencyAnalyzer) {
        dependencyAnalyzer.handleDocumentClose(event.document.uri);
    }
});

documents.listen(connection);
connection.listen();
