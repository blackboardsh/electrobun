import * as monaco from "monaco-editor";
import { electrobun } from "../init";
import { createSignal } from "solid-js";
import { state } from "../store";

export interface AICompletionRequest {
  prefix: string;
  suffix: string;
  language: string;
  filename: string;
  position: monaco.Position;
  triggerCharacter?: string;
}

export interface AICompletionResponse {
  suggestions: monaco.languages.CompletionItem[];
}

export interface AIInlineCompletionResponse {
  items: monaco.languages.InlineCompletion[];
}

export interface LlamaCompletionRequest {
  model: string;
  prompt: string;
  options?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    repeat_penalty?: number;
    stop?: string[];
  };
}

export interface LlamaCompletionResponse {
  response: string;
  ok: boolean;
  error?: string;
}

function cleanInlineCompletion(
  raw: string,
  langHint: string | undefined, // e.g. "typescript" or file extension
  {
    maxLines = 3,
    stopAtDoubleNewline = true,
  }: { maxLines?: number; stopAtDoubleNewline?: boolean } = {}
): string {
  // Minimal cleaning - just remove FIM tokens and trim
  let s = raw.trim();
  
  if (!s) return "";
  
  // Remove FIM special tokens that might appear in responses
  s = s
    .replace(/<\|fim_(?:prefix|middle|suffix|end)\|>/g, "")
    .replace(/<\|endoftext\|>/g, "")
    .replace(/<\|im_end\|>/g, "")
    .trim();
  
  // Stop at double newlines for inline completions
  const blankIdx = s.indexOf("\n\n");
  if (blankIdx !== -1) s = s.slice(0, blankIdx).trim();
  
  // Filter out obviously bad completions (repeated characters)
  if (/^(.)\1{10,}$/.test(s)) {
    console.log('🚫 Filtering out repetitive completion:', s.slice(0, 20) + '...');
    return "";
  }
  
  // Filter out completions that are just markdown code fences
  if (/^`{3,}$/.test(s)) {
    console.log('🚫 Filtering out code fence completion');
    return "";
  }
  
  return s;
}

// Global signal for tracking active completion requests
const [activeRequests, setActiveRequests] = createSignal(0);

class AICompletionService {
  private readonly COMPLETION_TIMEOUT = 30000; // 30 seconds max for tab completion (increased for VM)
  
  private get modelName() {
    return state.appSettings.llama.model;
  }
  
  private get temperature() {
    return state.appSettings.llama.temperature;
  }
  
  private get isEnabled() {
    return state.appSettings.llama.enabled;
  }
  
  private get isInlineEnabled() {
    return state.appSettings.llama.inlineEnabled;
  }
  
  
  // Track active requests for cancellation
  private activeAbortControllers = new Set<AbortController>();

  async isAvailable(): Promise<boolean> {
    if (!this.isEnabled) {
      return false;
    }
    
    try {
      const result = await electrobun.rpc?.request.llamaListModels();
      return result?.ok && result.models?.length > 0;
    } catch {
      return false;
    }
  }

  async isModelAvailable(): Promise<boolean> {
    if (!this.isEnabled) {
      return false;
    }
    
    try {
      const result = await electrobun.rpc?.request.llamaListModels();
      if (!result?.ok) return false;
      
      const modelName = this.modelName;
      return result.models?.some((model: any) => 
        model.name === modelName || model.path.includes(modelName)
      ) || false;
    } catch {
      return false;
    }
  }

  
  getActiveRequestsCount() {
    return activeRequests;
  }

  // Cancel all pending requests to prevent queue buildup
  cancelAllPendingRequests() {
    console.log(`🚫 Cancelling ${this.activeAbortControllers.size} pending AI requests`);
    this.activeAbortControllers.forEach(controller => {
      controller.abort();
    });
    this.activeAbortControllers.clear();
    setActiveRequests(0);
  }


  async getInlineCompletions(request: AICompletionRequest): Promise<AIInlineCompletionResponse> {
    
    // Check if enabled
    if (!this.isEnabled || !this.isInlineEnabled) {
      return { items: [] };
    }
    
    // Cancel any existing requests before starting a new one
    this.cancelAllPendingRequests();
    
    // Create abort controller for this request
    const abortController = new AbortController();
    this.activeAbortControllers.add(abortController);
    
    // Add a small delay to debounce rapid typing
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 150);
        // If aborted during delay, reject immediately
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new Error('Aborted'));
        });
      });
    } catch {
      // Request was aborted during delay
      this.activeAbortControllers.delete(abortController);
      return { items: [] };
    }
    
    // Check if already aborted after delay
    if (abortController.signal.aborted) {
      this.activeAbortControllers.delete(abortController);
      return { items: [] };
    }
    
    // Increment active request counter
    setActiveRequests(prev => prev + 1);
    
    try {
      // Use proper FIM format for Qwen2.5-Coder with enhanced context
      // Add file type, name, and task context to improve completions
      const fileExtension = request.filename.split('.').pop() || '';
      const languageContext = request.language || fileExtension;
      const fileContext = '';//`// File: ${request.filename} (${languageContext})\n// Task: Code completion\n`;
      
      let prompt: string;      
      // if (request.suffix && request.suffix.trim().length > 0) {        
      //   // Use FIM format when we have both prefix and suffix context
      //   prompt = `${fileContext}<|fim_prefix|>${request.prefix}<|fim_suffix|>${request.suffix}<|fim_middle|>`;
      // } else {
        // Fallback to simple completion when no suffix context
        prompt = `${fileContext}Complete this ${languageContext} code:\n${request.prefix}`;
      // }

      console.log('Completion prompt for', request.language, 'file:', request.filename);
      console.log('prompt:', prompt);
      
      // Check if aborted before making the request
      if (abortController.signal.aborted) {
        this.activeAbortControllers.delete(abortController);
        setActiveRequests(prev => Math.max(0, prev - 1));
        return { items: [] };
      }
      
      // First try llama-cli for better performance
      let result = await electrobun.rpc?.request.llamaCompletion({
        model: this.modelName,
        prompt,
        options: {
          temperature: this.temperature, // Use configured temperature
          top_p: 1.0,
          max_tokens: 100, // Allow longer completions for inline
          stop: ["<|fim_end|>", "<|endoftext|>"], // Only stop on special model tokens, not valid TypeScript
        },
      });

      // If llama-cli fails, return empty completions
      if (!result?.ok) {
        console.log('llama-cli failed:', result?.error || 'unknown error');
        return { items: [] };
      }

      console.log('raw result: ', result.response)

      let completion = (result.response || "").trim();


      if (!completion || completion.length === 0) {
        return { items: [] };
      }

      console.log('completion before cleaning:', JSON.stringify(completion));
      completion = cleanInlineCompletion(completion, request.language);
      console.log('completion after cleaning:', JSON.stringify(completion));

      // For inline completions, prefer single-line suggestions but allow multi-line
      const lines = completion.split('\n');
      if (lines.length > 3) {
        // If too many lines, just take the first few
        completion = lines.slice(0, 3).join('\n');
      }

      if (completion.length === 0) {
        return { items: [] };
      }

      // Handle character duplication by checking if completion starts with already typed characters
      const currentLineContent = request.prefix.split('\n').pop() || '';
      const lastWord = currentLineContent.match(/[a-zA-Z_$][a-zA-Z0-9_$]*$/)?.[0] || '';
      
      // If there's a partial word typed and the completion starts with those characters,
      // remove the duplicated part from the completion
      if (lastWord.length > 0 && completion.toLowerCase().startsWith(lastWord.toLowerCase())) {
        completion = completion.slice(lastWord.length);
      }

      if (completion.length === 0) {
        return { items: [] };
      }

      // Filter out nonsensical completions
      // Reject completions that are just random words unrelated to code
      const commonNonCodeWords = ['typescript', 'javascript', 'python', 'java', 'react', 'angular', 'vue'];
      
      // If the completion is just a random word that doesn't relate to what was typed, reject it
      if (lastWord.length === 1 && commonNonCodeWords.some(word => 
        completion.toLowerCase().trim() === word.toLowerCase())) {
        return { items: [] };
      }

      // Create inline completion item
      const inlineItem: monaco.languages.InlineCompletion = {
        insertText: completion,
        range: {
          startLineNumber: request.position.lineNumber,
          startColumn: request.position.column,
          endLineNumber: request.position.lineNumber,
          endColumn: request.position.column,
        },
      };

      return { items: [inlineItem] };
    } catch (error) {
      // Check if the error is due to abortion
      if (error.name === 'AbortError') {
        return { items: [] };
      }
      return { items: [] };
    } finally {
      // Clean up abort controller
      this.activeAbortControllers.delete(abortController);
      // Decrement active request counter
      setActiveRequests(prev => Math.max(0, prev - 1));
    }
  }

  // Method to install the model if not available
  async setupModel(): Promise<boolean> {
    try {
      // For now, return true since model installation is handled through LlamaSettings
      // TODO: Could integrate with llamaInstallModel RPC method
      return true;
    } catch (error) {
      return false;
    }
  }
}

export const aiCompletionService = new AICompletionService();