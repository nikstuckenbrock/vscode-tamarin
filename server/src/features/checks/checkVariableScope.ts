import { build_error_display } from './utils';
import { TamarinSymbolTable } from '../../symbol_table/create_symbol_table';
import { TextDocument } from "vscode-languageserver-textdocument";
import { Diagnostic } from 'vscode-languageserver';
import { DeclarationType } from "../../symbol_table/tamarinTypes";
import { DependencyAnalyzer } from '../../dependencyAnalyzer';

/**
 * Function used to check if a variable present in an action fact or conclusion is also present in premise,
 * also checks if a fact in premise appears in a conclusion somewhere else
 * @param symbolTable
 * @param editor
 * @param allSymbolTables
 * @returns
 */
export function check_variable_is_defined_in_premise(
    symbolTable: TamarinSymbolTable,
    editor: TextDocument,
    dependencyAnalyzer: DependencyAnalyzer
): Diagnostic[] {
    const diags: Diagnostic[] = [];
    for (let i = 0; i < symbolTable.getSymbols().length; i++) {
        const current_symbol = symbolTable.getSymbol(i);
        if (current_symbol.type === '$') { continue }
        if (current_symbol.declaration === DeclarationType.CCLVariable || current_symbol.declaration === DeclarationType.ActionFVariable) {
            const current_context = current_symbol.context;
            let is_break = false;
            for (let j = 0; j < symbolTable.getSymbols().length; j++) {
                const searched_symbol = symbolTable.getSymbol(j);
                if (j > i) { break }
                if (searched_symbol.context !== current_context || j == i) {
                    continue;
                }
                else {
                    if (searched_symbol.name === current_symbol.name) {
                        is_break = true
                        break;
                    }
                }
            }
            if (!is_break) {
                diags.push(build_error_display(current_symbol.node, editor, "Error: this variable is used in the second part of the rule but doesn't appear in premise"));
            }
        }
        else if ((current_symbol.declaration === DeclarationType.LinearF || current_symbol.declaration === DeclarationType.PersistentF) && current_symbol.node.parent?.grammarType === DeclarationType.Premise) {
            let isbreak = false;

            const rootDocument = dependencyAnalyzer.findRoot(editor.uri)
            for (const symbol of dependencyAnalyzer.findSymbolsForRoot(rootDocument)) {
                if ((symbol.declaration === DeclarationType.LinearF || symbol.declaration === DeclarationType.PersistentF) && symbol.node.id !== current_symbol.node.id) {
                    if (symbol.node.parent?.grammarType === DeclarationType.Conclusion && symbol.name === current_symbol.name) {
                        isbreak = true
                        break;
                    }
                }
            }
            if (!isbreak) {
                diags.push(build_error_display(current_symbol.node, editor, "Error: fact occur in premise but never in any conclusion "))
            }
        }
    }
    return diags
}