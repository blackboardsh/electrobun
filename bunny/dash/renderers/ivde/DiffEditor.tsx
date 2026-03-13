import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { onMount, type Accessor } from "solid-js";
import * as monaco from "monaco-editor";

declare global {
  interface Window {
    stagingDecorationIds?: string[];
  }
}

// IDiffNavigator type is incomplete defined at esm/vs/editor/editor.api.d.ts
// DiffNavigator class is defined at esm/vs/editor/browser/widget/diffNavigator.js
type ActualDiffEditorClassType = monaco.editor.IDiffNavigator & {
  nextIdx: number;
  // The range class is defined at esm/vs/editor/common/core/range.js
  // but we only really care about the length of the array for now
  ranges: any[];
  // canNavigate(): boolean;
  // canNavigateLoop(): boolean;
};

export const DiffEditor = ({
  originalText,
  modifiedText,
  onStageLines,
  onUnstageLines,
  canStageLines = false,
  filePath,
  isStaged = false,
}: {
  originalText: Accessor<string>;
  modifiedText: Accessor<string>;
  onStageLines?: (filePath: string, startLine: number, endLine: number, lineChange?: any, originalText?: string, modifiedText?: string) => void;
  onUnstageLines?: (filePath: string, startLine: number, endLine: number, lineChange?: any, originalText?: string, stagedText?: string) => void;
  canStageLines?: boolean;
  filePath?: string;
  isStaged?: boolean;
}) => {
  let editorRef: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneDiffEditor | undefined;
  let originalModel: monaco.editor.ITextModel | undefined;
  let modifiedModel: monaco.editor.ITextModel | undefined;
  let diffNavigator: ActualDiffEditorClassType | undefined;
  let currentDiffIndex = 0;
  
  const [diffPosition, setDiffPosition] = createSignal({
    current: 0,
    total: 0,
  });
  const [hasSelection, setHasSelection] = createSignal(false);

  onMount(() => {
    if (!editorRef) {
      return;
    }

    // Add CSS for staging glyphs once
    if (!document.querySelector('#staging-glyph-styles')) {
      const style = document.createElement('style');
      style.id = 'staging-glyph-styles';
      style.textContent = `
        .stage-line-glyph {
          cursor: pointer !important;
          width: 14px !important;
          height: 14px !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          border-radius: 3px !important;
          margin: 1px !important;
          transition: all 0.15s ease !important;
          font-family: 'SF Pro Display', 'Segoe UI', system-ui, sans-serif !important;
        }
        
        .stage-line-glyph.stage {
          background: rgba(0, 0, 0, 0.6) !important;
          border: 1px solid rgba(255, 255, 255, 0.3) !important;
          color: #22c55e !important;
        }
        
        .stage-line-glyph.unstage {
          background: rgba(0, 0, 0, 0.6) !important;
          border: 1px solid rgba(255, 255, 255, 0.3) !important;
          color: #ef4444 !important;
        }
        
        .stage-line-glyph.stage::before {
          content: "+" !important;
          font-weight: 700 !important;
          font-size: 10px !important;
          line-height: 1 !important;
        }
        
        .stage-line-glyph.unstage::before {
          content: "−" !important;
          font-weight: 700 !important;
          font-size: 10px !important;
          line-height: 1 !important;
        }
        
        .stage-line-glyph.stage:hover {
          background: rgba(0, 0, 0, 0.8) !important;
          border-color: rgba(255, 255, 255, 0.5) !important;
          transform: translateY(-1px) !important;
          color: #16a34a !important;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4) !important;
        }
        
        .stage-line-glyph.unstage:hover {
          background: rgba(0, 0, 0, 0.8) !important;
          border-color: rgba(255, 255, 255, 0.5) !important;
          transform: translateY(-1px) !important;
          color: #dc2626 !important;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4) !important;
        }
      `;
      document.head.appendChild(style);
    }

    editor = monaco.editor.createDiffEditor(editorRef, {
      originalEditable: false,
      theme: "vs-dark",
      hover: { enabled: false },
      minimap: { enabled: true },
      lineNumbers: "on",
      inlayHints: {},
      readOnly: true,
      automaticLayout: true,
      glyphMargin: true, // Enable glyph margin for staging controls
    });

    // https://code.visualstudio.com/api/references/theme-color
    monaco.editor.defineTheme("myCustomTheme", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "diffEditor.insertedTextBackground": "#0c451a",
        // "diffEditor.insertedTextBorder": "#fff",
        "diffEditor.removedTextBackground": "#4a1c1e",
        // "diffEditor.removedTextBorder": "#fff",
        // "diffEditor.border": "#fff",
        // "diffEditor.diagonalFill": "#fff",
        "diffEditor.insertedLineBackground": "#0c451a",
        "diffEditor.removedLineBackground": "#4a1c1e",
        "diffEditorGutter.insertedLineBackground": "#0c451a",
        "diffEditorGutter.removedLineBackground": "#4a1c1e",
        "diffEditorOverview.insertedForeground": "#0c451a",
        "diffEditorOverview.removedForeground": "#4a1c1e",

        // Note: might need to upgrade for these to work
        // "diffEditor.unchangedRegionBackground": "#fff",
        // "diffEditor.unchangedRegionForeground": "#fff",
        // "diffEditor.unchangedRegionShadow": "#fff",
        // "diffEditor.unchangedCodeBackground": "#fff",
        // "diffEditor.move": "#fff",
        // "diffEditor.moveActive": "#fff",
        // "multiDiffEditor.headerBackground": "#fff",
      },
    });

    monaco.editor.setTheme("myCustomTheme");

    try {
      // Try the newer API first
      diffNavigator = (monaco.editor as any).createDiffNavigator(editor, {
        followsCaret: false,
        ignoreCharChanges: true,
      }) as ActualDiffEditorClassType;
    } catch (error) {
      console.warn('DiffNavigator not available:', error);
      // Create a mock navigator if the real one fails
      diffNavigator = {
        nextIdx: 0,
        ranges: [],
        next: () => {},
        previous: () => {},
      } as ActualDiffEditorClassType;
    }

    editor.onDidUpdateDiff(() => {
      console.log("Diff updated!");
      
      // Get line changes from the diff editor
      const lineChanges = editor.getLineChanges();
      console.log("Line changes:", lineChanges);
      
      if (lineChanges && lineChanges.length > 0) {
        // Reset to first change
        currentDiffIndex = 0;
        
        // Update the position based on actual changes
        setDiffPosition({
          current: 1,
          total: lineChanges.length,
        });
        
        // Navigate to first change
        const firstChange = lineChanges[0];
        if (firstChange.modifiedStartLineNumber) {
          editor.revealLineInCenter(firstChange.modifiedStartLineNumber);
          const modifiedEditor = editor.getModifiedEditor();
          modifiedEditor.setPosition({ lineNumber: firstChange.modifiedStartLineNumber, column: 1 });
        }
        
        // Add staging decorations directly here where we have the line changes
        console.log("Adding staging decorations directly in onDidUpdateDiff");
        
        const stagingDecorations: any[] = [];
        
        // Add staging controls for each change
        for (const change of lineChanges) {
          const startLine = change.modifiedStartLineNumber || 0;
          
          // Add decoration for the first line of each change
          if (startLine > 0) {
            stagingDecorations.push({
              range: new monaco.Range(startLine, 1, startLine, 1),
              options: {
                glyphMarginClassName: isStaged ? 'staging-glyph-unstage' : 'staging-glyph-stage',
                glyphMarginHoverMessage: {
                  value: isStaged ? 'Click to unstage this change' : 'Click to stage this change'
                }
              }
            });
          }
        }
        
        console.log("Adding", stagingDecorations.length, "staging decorations in onDidUpdateDiff");
        
        // Add CSS for staging glyphs if not already added
        if (!document.querySelector('#staging-glyph-styles-direct')) {
          const style = document.createElement('style');
          style.id = 'staging-glyph-styles-direct';
          style.textContent = `
            .staging-glyph-stage,
            .staging-glyph-unstage {
              cursor: pointer !important;
              width: 14px !important;
              height: 14px !important;
              display: inline-flex !important;
              align-items: center !important;
              justify-content: center !important;
              border-radius: 3px !important;
              margin: 1px !important;
              transition: all 0.15s ease !important;
              font-family: 'SF Pro Display', 'Segoe UI', system-ui, sans-serif !important;
            }
            
            .staging-glyph-stage {
              background: rgba(0, 0, 0, 0.6) !important;
              border: 1px solid rgba(255, 255, 255, 0.3) !important;
            }
            
            .staging-glyph-unstage {
              background: rgba(0, 0, 0, 0.6) !important;
              border: 1px solid rgba(255, 255, 255, 0.3) !important;
            }
            
            .staging-glyph-stage::before {
              content: "+" !important;
              color: #22c55e !important;
              font-weight: 700 !important;
              font-size: 10px !important;
              line-height: 1 !important;
            }
            
            .staging-glyph-unstage::before {
              content: "−" !important;
              color: #ef4444 !important;
              font-weight: 700 !important;
              font-size: 10px !important;
              line-height: 1 !important;
            }
            
            .staging-glyph-stage:hover {
              background: rgba(0, 0, 0, 0.8) !important;
              border-color: rgba(255, 255, 255, 0.5) !important;
              transform: translateY(-1px) !important;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4) !important;
            }
            
            .staging-glyph-unstage:hover {
              background: rgba(0, 0, 0, 0.8) !important;
              border-color: rgba(255, 255, 255, 0.5) !important;
              transform: translateY(-1px) !important;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4) !important;
            }
            
            .staging-glyph-stage:hover::before {
              color: #16a34a !important;
            }
            
            .staging-glyph-unstage:hover::before {
              color: #dc2626 !important;
            }
          `;
          document.head.appendChild(style);
        }
        
        // Apply the decorations
        const decorationIds = modifiedEditor.deltaDecorations([], stagingDecorations);
        console.log("Direct staging decoration IDs:", decorationIds);
      }
    });

    originalModel = monaco.editor.createModel("", "plaintext");
    modifiedModel = monaco.editor.createModel("", "plaintext");

    editor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    // Track selection changes to show/hide selection buttons
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.onDidChangeCursorSelection((e) => {
      setHasSelection(!e.selection.isEmpty());
    });
    
    // Handle clicks on the glyph margin for staging
    modifiedEditor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const lineNumber = e.target.position?.lineNumber;
        
        if (lineNumber) {
          // Find which change this line belongs to
          const lineChanges = editor.getLineChanges();
          if (lineChanges && lineChanges.length > 0) {
            for (const change of lineChanges) {
              const startLine = change.modifiedStartLineNumber || 0;
              const endLine = change.modifiedEndLineNumber || 0;
              
              if (startLine <= lineNumber && lineNumber <= endLine) {
                // Try to extract file path from the diff or use prop
                let currentFilePath = filePath;
                
                // If no filePath prop, try to extract from the line changes
                if (!currentFilePath && editor) {
                  const lineChanges = editor.getLineChanges();
                  // We could extract from git diff header if needed, but for now try prop or fallback
                  currentFilePath = "src/core/utils.ts"; // TODO: Extract from diff header
                }
                
                // Handle staging or unstaging based on current state
                if (isStaged && onUnstageLines && currentFilePath) {
                  onUnstageLines(currentFilePath, startLine, endLine, change, originalText(), modifiedText());
                } else if (!isStaged && onStageLines && currentFilePath) {
                  onStageLines(currentFilePath, startLine, endLine, change, originalText(), modifiedText());
                }
                break;
              }
            }
          }
        }
      }
    });


    // setTimeout(() => {
    //   originalModel.setValue("hi\nlkajsdf\nlaksjf");
    //   modifiedModel.setValue("blob blob");
    //   editor.setModel({
    //     original: monaco.editor.createModel("", "plaintext"),
    //     modified: monaco.editor.createModel("", "plaintext"),
    //   });
    // }, 5000);
  });

  const nextDiff = () => {
    if (!editor) return;
    
    const lineChanges = editor.getLineChanges();
    if (!lineChanges || lineChanges.length === 0) return;
    
    // Move to next change
    currentDiffIndex = (currentDiffIndex + 1) % lineChanges.length;
    const change = lineChanges[currentDiffIndex];
    
    // Jump to the change
    if (change.modifiedStartLineNumber) {
      editor.revealLineInCenter(change.modifiedStartLineNumber);
      const modifiedEditor = editor.getModifiedEditor();
      modifiedEditor.setPosition({ lineNumber: change.modifiedStartLineNumber, column: 1 });
    }
    
    setDiffPosition({
      current: currentDiffIndex + 1,
      total: lineChanges.length,
    });
  };

  const prevDiff = () => {
    if (!editor) return;
    
    const lineChanges = editor.getLineChanges();
    if (!lineChanges || lineChanges.length === 0) return;
    
    // Move to previous change
    currentDiffIndex = currentDiffIndex > 0 ? currentDiffIndex - 1 : lineChanges.length - 1;
    const change = lineChanges[currentDiffIndex];
    
    // Jump to the change
    if (change.modifiedStartLineNumber) {
      editor.revealLineInCenter(change.modifiedStartLineNumber);
      const modifiedEditor = editor.getModifiedEditor();
      modifiedEditor.setPosition({ lineNumber: change.modifiedStartLineNumber, column: 1 });
    }
    
    setDiffPosition({
      current: currentDiffIndex + 1,
      total: lineChanges.length,
    });
  };

  onCleanup(() => {
    // Detach models from editor before disposing them
    if (editor) {
      editor.setModel(null);
    }
    if (originalModel) originalModel.dispose();
    if (modifiedModel) modifiedModel.dispose();
    if (editor) editor.dispose();
  });

  // Staging controls state
  let currentDecorations: string[] = [];
  
  // Function to update staging decorations
  const updateStagingDecorations = () => {
    if (!editor) return;
    
    console.log("updateStagingDecorations called - canStageLines:", canStageLines, "filePath:", filePath, "isStaged:", isStaged);
    
    const modifiedEditor = editor.getModifiedEditor();
    const lineChanges = editor.getLineChanges();
    
    // Clear existing staging decorations
    if (window.stagingDecorationIds && window.stagingDecorationIds.length > 0) {
      window.stagingDecorationIds = modifiedEditor.deltaDecorations(window.stagingDecorationIds, []);
    }
    
    console.log("Line changes available:", !!lineChanges, "count:", lineChanges?.length);
    
    // TEMP: Force staging glyphs to appear for testing
    if (lineChanges && lineChanges.length > 0) {
      console.log("FORCING staging decorations for", lineChanges.length, "changes");
      
      const stagingDecorations: any[] = [];
      
      // Add staging controls for each change
      for (const change of lineChanges) {
        const startLine = change.modifiedStartLineNumber || 0;
        
        // Add decoration for the first line of each change
        if (startLine > 0) {
          stagingDecorations.push({
            range: new monaco.Range(startLine, 1, startLine, 1),
            options: {
              glyphMarginClassName: isStaged ? 'staging-glyph-unstage' : 'staging-glyph-stage',
              glyphMarginHoverMessage: {
                value: isStaged ? 'Click to unstage this change' : 'Click to stage this change'
              }
            }
          });
        }
      }
      
      console.log("Adding", stagingDecorations.length, "staging decorations");
      
      // Add CSS for staging glyphs if not already added
      if (!document.querySelector('#staging-glyph-styles-final')) {
        const style = document.createElement('style');
        style.id = 'staging-glyph-styles-final';
        style.textContent = `
          .staging-glyph-stage,
          .staging-glyph-unstage {
            cursor: pointer !important;
            width: 14px !important;
            height: 14px !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            border-radius: 3px !important;
            margin: 1px !important;
            transition: all 0.15s ease !important;
            font-family: 'SF Pro Display', 'Segoe UI', system-ui, sans-serif !important;
          }
          
          .staging-glyph-stage {
            background: rgba(255, 255, 255, 0.1) !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
          }
          
          .staging-glyph-unstage {
            background: rgba(255, 255, 255, 0.1) !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
          }
          
          .staging-glyph-stage::before {
            content: "+" !important;
            color: #22c55e !important;
            font-weight: 700 !important;
            font-size: 10px !important;
            line-height: 1 !important;
          }
          
          .staging-glyph-unstage::before {
            content: "−" !important;
            color: #ef4444 !important;
            font-weight: 700 !important;
            font-size: 10px !important;
            line-height: 1 !important;
          }
          
          .staging-glyph-stage:hover {
            background: rgba(255, 255, 255, 0.2) !important;
            border-color: rgba(255, 255, 255, 0.4) !important;
            transform: translateY(-1px) !important;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2) !important;
          }
          
          .staging-glyph-unstage:hover {
            background: rgba(255, 255, 255, 0.2) !important;
            border-color: rgba(255, 255, 255, 0.4) !important;
            transform: translateY(-1px) !important;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2) !important;
          }
          
          .staging-glyph-stage:hover::before {
            color: #16a34a !important;
          }
          
          .staging-glyph-unstage:hover::before {
            color: #dc2626 !important;
          }
        `;
        document.head.appendChild(style);
      }
      
      // Store the decoration IDs globally
      if (!window.stagingDecorationIds) {
        window.stagingDecorationIds = [];
      }
      window.stagingDecorationIds = modifiedEditor.deltaDecorations(window.stagingDecorationIds || [], stagingDecorations);
      console.log("Staging decoration IDs:", window.stagingDecorationIds);
    }
  };
  
  createEffect(() => {
    if (originalModel && modifiedModel && editor) {
      const newOriginal = originalText();
      const newModified = modifiedText();

      // Skip re-render if contents haven't changed
      const oldOriginal = originalModel.getValue();
      const oldModified = modifiedModel.getValue();

      if (newOriginal === oldOriginal && newModified === oldModified) {
        return;
      }

      editor.revealLine(1);
      originalModel.setValue(newOriginal);
      modifiedModel.setValue(newModified);

      const newLanguage = "typescript";
      monaco.editor.setModelLanguage(originalModel, newLanguage);
      monaco.editor.setModelLanguage(modifiedModel, newLanguage);
      if (diffNavigator) {
        diffNavigator.next();
      }
    }
  });
  
  // Update staging decorations when props change
  createEffect(() => {
    // Track the props that affect staging decorations
    const _canStageLines = canStageLines;
    const _filePath = filePath;
    const _isStaged = isStaged;
    
    console.log("Props changed - canStageLines:", _canStageLines, "filePath:", _filePath, "isStaged:", _isStaged);
    updateStagingDecorations();
  });
  
  // Set up staging controls that are always visible
  createEffect(() => {
    console.log("=== STAGING EFFECT START ===");
    console.log("Editor exists:", !!editor);
    console.log("canStageLines:", canStageLines);
    console.log("filePath:", filePath);
    console.log("isStaged:", isStaged);
    
    if (!editor) {
      console.log("No editor yet, waiting...");
      return;
    }
    
    const modifiedEditor = editor.getModifiedEditor();
    if (!modifiedEditor) {
      console.log("No modified editor yet, waiting...");
      return;
    }
    
    console.log("Staging controls setup - canStageLines:", canStageLines, "filePath:", filePath, "isStaged:", isStaged);
    console.log("Will use glyph class:", isStaged ? 'staging-glyph-unstage' : 'staging-glyph-stage');
    
    // Only set up if staging is enabled
    if (canStageLines && filePath) {
      // Add decorations for all changed lines
      const lineChanges = editor.getLineChanges();
      console.log("Adding decorations for all line changes:", lineChanges);
      
      if (lineChanges && lineChanges.length > 0) {
        const decorations: any[] = [];
        
        // Add a decoration for each changed line
        for (const change of lineChanges) {
          const startLine = change.modifiedStartLineNumber || 0;
          const endLine = change.modifiedEndLineNumber || 0;
          
          // Add decoration for each line in the change
          for (let line = startLine; line <= endLine; line++) {
            decorations.push({
              range: new monaco.Range(line, 1, line, 1),
              options: {
                isWholeLine: false,
                glyphMarginClassName: isStaged ? 'staging-glyph-unstage' : 'staging-glyph-stage',
                glyphMarginHoverMessage: {
                  value: isStaged ? 'Click to unstage this change' : 'Click to stage this change'
                }
              }
            });
          }
        }
        
        console.log("Adding", decorations.length, "decorations");
        currentDecorations = modifiedEditor.deltaDecorations(currentDecorations, decorations);
        
        // Add CSS for staging glyphs if not already added
        if (!document.querySelector('#staging-glyph-styles-permanent')) {
          const style = document.createElement('style');
          style.id = 'staging-glyph-styles-permanent';
          style.textContent = `
            .staging-glyph-stage,
            .staging-glyph-unstage {
              cursor: pointer !important;
              width: 14px !important;
              height: 14px !important;
              display: inline-flex !important;
              align-items: center !important;
              justify-content: center !important;
              border-radius: 3px !important;
              margin: 1px !important;
              transition: all 0.15s ease !important;
              font-family: 'SF Pro Display', 'Segoe UI', system-ui, sans-serif !important;
            }
            
            .staging-glyph-stage {
              background: rgba(0, 0, 0, 0.6) !important;
              border: 1px solid rgba(255, 255, 255, 0.3) !important;
            }
            
            .staging-glyph-unstage {
              background: rgba(0, 0, 0, 0.6) !important;
              border: 1px solid rgba(255, 255, 255, 0.3) !important;
            }
            
            .staging-glyph-stage::before {
              content: "+" !important;
              color: #22c55e !important;
              font-weight: 700 !important;
              font-size: 10px !important;
              line-height: 1 !important;
            }
            
            .staging-glyph-unstage::before {
              content: "−" !important;
              color: #ef4444 !important;
              font-weight: 700 !important;
              font-size: 10px !important;
              line-height: 1 !important;
            }
            
            .staging-glyph-stage:hover {
              background: rgba(0, 0, 0, 0.8) !important;
              border-color: rgba(255, 255, 255, 0.5) !important;
              transform: translateY(-1px) !important;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4) !important;
            }
            
            .staging-glyph-unstage:hover {
              background: rgba(0, 0, 0, 0.8) !important;
              border-color: rgba(255, 255, 255, 0.5) !important;
              transform: translateY(-1px) !important;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4) !important;
            }
            
            .staging-glyph-stage:hover::before {
              color: #16a34a !important;
            }
            
            .staging-glyph-unstage:hover::before {
              color: #dc2626 !important;
            }
          `;
          document.head.appendChild(style);
        }
        
        // Handle clicks on the glyph margin
        const mouseDownDisposable = modifiedEditor.onMouseDown((e) => {
          console.log("Mouse down on:", e.target.type);
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = e.target.position?.lineNumber;
            console.log("Clicked on glyph margin at line:", lineNumber);
            if (lineNumber) {
              // Find the diff range this line belongs to
              const lineChanges = editor?.getLineChanges();
              if (lineChanges && lineChanges.length > 0) {
                for (const change of lineChanges) {
                  const startLine = change.modifiedStartLineNumber || 0;
                  const endLine = change.modifiedEndLineNumber || 0;
                  if (startLine <= lineNumber && lineNumber <= endLine) {
                    // Stage or unstage the entire change based on current state
                    console.log("Staging/unstaging change:", startLine, "-", endLine);
                    if (isStaged && onUnstageLines) {
                      console.log("Unstaging with change object:", JSON.stringify(change));
                      onUnstageLines(filePath, startLine, endLine, change, originalText(), modifiedText());
                    } else if (!isStaged && onStageLines) {
                      onStageLines(filePath, startLine, endLine, change, originalText(), modifiedText());
                    }
                    break;
                  }
                }
              }
            }
          }
        });
        
        // Cleanup function
        onCleanup(() => {
          currentDecorations = modifiedEditor.deltaDecorations(currentDecorations, []);
          mouseDownDisposable.dispose();
        });
      }
    } else {
      // Clear decorations if staging is disabled
      if (currentDecorations.length > 0) {
        currentDecorations = modifiedEditor.deltaDecorations(currentDecorations, []);
      }
    }
  });

  return (
    <div style="width:100%;height:100%;">
      <div style={{
        display: "flex",
        "justify-content": "space-between",
        "align-items": "center",
        height: "40px",
        background: "#1e1e1e",
        "border-bottom": "1px solid #2d2d2d",
        padding: "0 12px",
        "font-family": "'Segoe UI', system-ui, sans-serif"
      }}>
        <button
          onClick={prevDiff}
          type="button"
          style={{
            background: "transparent",
            border: "1px solid #555",
            color: "#cccccc",
            "font-size": "11px",
            padding: "4px 8px",
            "border-radius": "3px",
            cursor: "pointer",
            "font-family": "'Segoe UI', system-ui, sans-serif",
            display: "flex",
            "align-items": "center",
            gap: "4px",
            "min-width": "90px",
            "justify-content": "center"
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          <span style="font-size: 12px;">←</span>
          Previous
        </button>
        
        <span style={{
          "font-size": "12px",
          color: "#888",
          "font-weight": "500",
          "letter-spacing": "0.5px"
        }}>
          {diffPosition().current} of {diffPosition().total}
        </span>
        
        <button
          onClick={nextDiff}
          type="button"
          style={{
            background: "transparent",
            border: "1px solid #555",
            color: "#cccccc",
            "font-size": "11px",
            padding: "4px 8px",
            "border-radius": "3px",
            cursor: "pointer",
            "font-family": "'Segoe UI', system-ui, sans-serif",
            display: "flex",
            "align-items": "center",
            gap: "4px",
            "min-width": "90px",
            "justify-content": "center"
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          Next
          <span style="font-size: 12px;">→</span>
        </button>
      </div>

      <div ref={editorRef} style="width:100%;height:calc(100% - 40px);" />
    </div>
  );
};
