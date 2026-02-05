/**
 * Shared menu role definitions used by ApplicationMenu, ContextMenu, and Tray menus.
 * These map to macOS NSResponder selectors for native text editing support.
 */

export const roleLabelMap: Record<string, string> = {
	// Application roles
	about: "About",
	quit: "Quit",
	hide: "Hide",
	hideOthers: "Hide Others",
	showAll: "Show All",

	// Window roles
	minimize: "Minimize",
	zoom: "Zoom",
	close: "Close",
	bringAllToFront: "Bring All To Front",
	cycleThroughWindows: "Cycle Through Windows",
	enterFullScreen: "Enter Full Screen",
	exitFullScreen: "Exit Full Screen",
	toggleFullScreen: "Toggle Full Screen",

	// Standard edit roles
	undo: "Undo",
	redo: "Redo",
	cut: "Cut",
	copy: "Copy",
	paste: "Paste",
	pasteAndMatchStyle: "Paste and Match Style",
	delete: "Delete",
	selectAll: "Select All",

	// Speech roles
	startSpeaking: "Start Speaking",
	stopSpeaking: "Stop Speaking",

	// Help
	showHelp: "Show Help",

	// Movement - basic
	moveForward: "Move Forward",
	moveBackward: "Move Backward",
	moveLeft: "Move Left",
	moveRight: "Move Right",
	moveUp: "Move Up",
	moveDown: "Move Down",

	// Movement - by word
	moveWordForward: "Move Word Forward",
	moveWordBackward: "Move Word Backward",
	moveWordLeft: "Move Word Left",
	moveWordRight: "Move Word Right",

	// Movement - by line
	moveToBeginningOfLine: "Move to Beginning of Line",
	moveToEndOfLine: "Move to End of Line",
	moveToLeftEndOfLine: "Move to Left End of Line",
	moveToRightEndOfLine: "Move to Right End of Line",

	// Movement - by paragraph
	moveToBeginningOfParagraph: "Move to Beginning of Paragraph",
	moveToEndOfParagraph: "Move to End of Paragraph",
	moveParagraphForward: "Move Paragraph Forward",
	moveParagraphBackward: "Move Paragraph Backward",

	// Movement - by document
	moveToBeginningOfDocument: "Move to Beginning of Document",
	moveToEndOfDocument: "Move to End of Document",

	// Movement with selection - basic
	moveForwardAndModifySelection: "Move Forward and Modify Selection",
	moveBackwardAndModifySelection: "Move Backward and Modify Selection",
	moveLeftAndModifySelection: "Move Left and Modify Selection",
	moveRightAndModifySelection: "Move Right and Modify Selection",
	moveUpAndModifySelection: "Move Up and Modify Selection",
	moveDownAndModifySelection: "Move Down and Modify Selection",

	// Movement with selection - by word
	moveWordForwardAndModifySelection: "Move Word Forward and Modify Selection",
	moveWordBackwardAndModifySelection: "Move Word Backward and Modify Selection",
	moveWordLeftAndModifySelection: "Move Word Left and Modify Selection",
	moveWordRightAndModifySelection: "Move Word Right and Modify Selection",

	// Movement with selection - by line
	moveToBeginningOfLineAndModifySelection:
		"Move to Beginning of Line and Modify Selection",
	moveToEndOfLineAndModifySelection:
		"Move to End of Line and Modify Selection",
	moveToLeftEndOfLineAndModifySelection:
		"Move to Left End of Line and Modify Selection",
	moveToRightEndOfLineAndModifySelection:
		"Move to Right End of Line and Modify Selection",

	// Movement with selection - by paragraph
	moveToBeginningOfParagraphAndModifySelection:
		"Move to Beginning of Paragraph and Modify Selection",
	moveToEndOfParagraphAndModifySelection:
		"Move to End of Paragraph and Modify Selection",
	moveParagraphForwardAndModifySelection:
		"Move Paragraph Forward and Modify Selection",
	moveParagraphBackwardAndModifySelection:
		"Move Paragraph Backward and Modify Selection",

	// Movement with selection - by document
	moveToBeginningOfDocumentAndModifySelection:
		"Move to Beginning of Document and Modify Selection",
	moveToEndOfDocumentAndModifySelection:
		"Move to End of Document and Modify Selection",

	// Page movement
	pageUp: "Page Up",
	pageDown: "Page Down",
	pageUpAndModifySelection: "Page Up and Modify Selection",
	pageDownAndModifySelection: "Page Down and Modify Selection",

	// Scrolling
	scrollLineUp: "Scroll Line Up",
	scrollLineDown: "Scroll Line Down",
	scrollPageUp: "Scroll Page Up",
	scrollPageDown: "Scroll Page Down",
	scrollToBeginningOfDocument: "Scroll to Beginning of Document",
	scrollToEndOfDocument: "Scroll to End of Document",
	centerSelectionInVisibleArea: "Center Selection in Visible Area",

	// Deletion - character
	deleteBackward: "Delete Backward",
	deleteForward: "Delete Forward",
	deleteBackwardByDecomposingPreviousCharacter:
		"Delete Backward by Decomposing Previous Character",

	// Deletion - word
	deleteWordBackward: "Delete Word Backward",
	deleteWordForward: "Delete Word Forward",

	// Deletion - line
	deleteToBeginningOfLine: "Delete to Beginning of Line",
	deleteToEndOfLine: "Delete to End of Line",

	// Deletion - paragraph
	deleteToBeginningOfParagraph: "Delete to Beginning of Paragraph",
	deleteToEndOfParagraph: "Delete to End of Paragraph",

	// Selection
	selectWord: "Select Word",
	selectLine: "Select Line",
	selectParagraph: "Select Paragraph",
	selectToMark: "Select to Mark",
	setMark: "Set Mark",
	swapWithMark: "Swap with Mark",
	deleteToMark: "Delete to Mark",

	// Text transformation
	capitalizeWord: "Capitalize Word",
	uppercaseWord: "Uppercase Word",
	lowercaseWord: "Lowercase Word",
	transpose: "Transpose",
	transposeWords: "Transpose Words",

	// Insertion
	insertNewline: "Insert Newline",
	insertLineBreak: "Insert Line Break",
	insertParagraphSeparator: "Insert Paragraph Separator",
	insertTab: "Insert Tab",
	insertBacktab: "Insert Backtab",
	insertTabIgnoringFieldEditor: "Insert Tab Ignoring Field Editor",
	insertNewlineIgnoringFieldEditor: "Insert Newline Ignoring Field Editor",

	// Kill ring (Emacs-style)
	yank: "Yank",
	yankAndSelect: "Yank and Select",

	// Completion
	complete: "Complete",
	cancelOperation: "Cancel Operation",

	// Indentation
	indent: "Indent",
};

export type MenuRole = keyof typeof roleLabelMap;
