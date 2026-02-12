import { TextDocument } from 'vscode-languageserver-textdocument';
import { TamarinSymbol } from '../../symbol_table/tamarinTypes';
import { DeclarationType } from '../../symbol_table/tamarinTypes';
import { check_variable_is_defined_in_premise } from '../checks/checkVariableScope';
import { createMockSymbol, createMockSymbolTable, createMockNode } from './utils';
import * as Parser from "web-tree-sitter";
import { DependencyAnalyzer } from '../../dependencyAnalyzer';
import * as path from 'path';

let dependencyAnalyzer: DependencyAnalyzer;
const mockDocument = TextDocument.create('file:///test.spthy', 'tamarin', 1, '');

beforeAll(async () => {
    dependencyAnalyzer = new DependencyAnalyzer();
    const SpthyParserPath = path.resolve(process.cwd(), 'server/grammar/tree-sitter-tamarin/tree-sitter-spthy.wasm');
    const SplibParserPath = path.resolve(process.cwd(), 'server/grammar/tree-sitter-tamarin/tree-sitter-splib.wasm');
    await dependencyAnalyzer.initParsers(SpthyParserPath, SplibParserPath);
    await dependencyAnalyzer.diagnoseDocument(mockDocument);
});

describe('checkVariableScope', () => {
    it('Should return no errors for a valid rule', () => {
        // SCÉNARIO : Rule `[ In(x) ] --> [ Out(x) ]`
        const sharedRuleContext = {
            id: 1,
            grammarType: 'rule',
            tree: {} as Parser.Tree,
            startIndex: 0,
            endIndex: 10,
            startPosition: { row: 0, column: 0 },
            endPosition: { row: 0, column: 10 },
        } as Parser.SyntaxNode;
        const symbols: TamarinSymbol[] = [
            createMockSymbol({
                name: 'x',
                declaration: DeclarationType.PRVariable,
                context: sharedRuleContext,
            }),
            createMockSymbol({
                name: 'x',
                declaration: DeclarationType.CCLVariable,
                context: sharedRuleContext,
            }),
        ];
        const symbolTable = createMockSymbolTable(symbols);
        const diagnostics = check_variable_is_defined_in_premise(symbolTable, mockDocument, dependencyAnalyzer);
        expect(diagnostics).toHaveLength(0);
    });

    it("Should return an error if a conclusion variable is not in the premise", () => {
        // SCÉNARIO : Rule `[ ] --> [ Out(y) ]`
        const symbols: TamarinSymbol[] = [
            createMockSymbol({
                name: 'y',
                declaration: DeclarationType.CCLVariable
            })
        ];
        const symbolTable = createMockSymbolTable(symbols);
        const diagnostics = check_variable_is_defined_in_premise(symbolTable, mockDocument, dependencyAnalyzer);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("doesn't appear in premise");
    });

    it("Should ignore public variables", () => {
        // SCÉNARIO : Rule `[ ] --> [ Out($y) ]`
        const symbols: TamarinSymbol[] = [
            createMockSymbol({
                name: '$y',
                declaration: DeclarationType.CCLVariable,
                type: '$',
            })
        ];
        const symbolTable = createMockSymbolTable(symbols);
        const diagnostics = check_variable_is_defined_in_premise(symbolTable, mockDocument, dependencyAnalyzer);
        expect(diagnostics).toHaveLength(0);
    });

    it("Should return an error if a fact in a premise is never used in a conclusion", () => {
        const premiseParentNode = createMockNode({
            id: 100,
            grammarType: 'premise'
        });
        const symbols: TamarinSymbol[] = [
            createMockSymbol({
                name: 'UnusedFact',
                declaration: DeclarationType.LinearF,
                nodeOptions: {
                    /* eslint-disable @typescript-eslint/no-explicit-any */
                    parent: premiseParentNode as any
                }
            }),
            createMockSymbol({
                name: 'x',
                declaration: DeclarationType.PRVariable,
                nodeOptions: {
                    /* eslint-disable @typescript-eslint/no-explicit-any */
                    parent: premiseParentNode as any
                }
            }),
        ];
        const symbolTable = createMockSymbolTable(symbols);
        const diagnostics = check_variable_is_defined_in_premise(symbolTable, mockDocument, dependencyAnalyzer);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("fact occur in premise but never in any conclusion");
    });
});
