import { type AppState, setState, state } from "../store";
import type { CachedFileType } from "../../../shared/types/types";
import { getSlateForNode } from "../files";
import { createSignal, createEffect, For, Show } from "solid-js";
import { produce } from "solid-js/store";
import { electrobun } from "../init";
import { join } from "../../utils/pathUtils";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface ChatHistory {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export const AgentSlate = ({
  node,
  tabId,
}: {
  node?: CachedFileType;
  tabId: string;
}) => {
  if (!node) {
    return null;
  }

  const slate = () => getSlateForNode(node);
  const [message, setMessage] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);
  const [availableModels, setAvailableModels] = createSignal<Array<{ name: string; path: string }>>([]);
  const [showSidebar, setShowSidebar] = createSignal(true);
  const [showSettings, setShowSettings] = createSignal(false);
  
  // Context file support
  const contextFilePath = node ? join(node.path, ".context.md") : "";
  const [contextContent, setContextContent] = createSignal("");
  
  // Chat scroll ref
  let chatContainerRef: HTMLDivElement;
  
  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    if (chatContainerRef) {
      chatContainerRef.scrollTop = chatContainerRef.scrollHeight;
    }
  };
  
  // Get chat histories from slate config
  const getChatHistories = (): ChatHistory[] => {
    const slateData = slate();
    if (slateData?.type === "agent" && slateData.config.chatHistories) {
      return slateData.config.chatHistories;
    }
    // Migrate old single conversation history to new format
    if (slateData?.type === "agent" && slateData.config.conversationHistory) {
      const oldHistory = slateData.config.conversationHistory as Message[];
      if (oldHistory.length > 0) {
        return [{
          id: "default",
          title: "Conversation",
          messages: oldHistory,
          createdAt: oldHistory[0]?.timestamp || Date.now(),
          updatedAt: oldHistory[oldHistory.length - 1]?.timestamp || Date.now(),
        }];
      }
    }
    return [];
  };

  const [chatHistories, setChatHistories] = createSignal<ChatHistory[]>(getChatHistories());
  const [currentChatId, setCurrentChatId] = createSignal<string | null>(
    getChatHistories().length > 0 ? getChatHistories()[0].id : null
  );

  // Get current conversation messages
  const getCurrentMessages = (): Message[] => {
    const chatId = currentChatId();
    if (!chatId) return [];
    const chat = chatHistories().find(c => c.id === chatId);
    return chat?.messages || [];
  };

  const [conversationHistory, setConversationHistory] = createSignal<Message[]>(getCurrentMessages());

  // Get current model from slate config or app settings
  const getCurrentModel = () => {
    const slateData = slate();
    if (slateData?.type === "agent" && slateData.config.model) {
      return slateData.config.model;
    }
    return state.appSettings.llama.model;
  };

  const [selectedModel, setSelectedModel] = createSignal(getCurrentModel());
  
  // AI Settings
  const getAISettings = () => {
    const slateData = slate();
    if (slateData?.type === "agent" && slateData.config.aiSettings) {
      return slateData.config.aiSettings;
    }
    return {
      temperature: 0.7,
      maxTokens: 2000,
      topP: 0.9,
      repeatPenalty: 1.1,
    };
  };

  const [temperature, setTemperature] = createSignal(getAISettings().temperature);
  const [maxTokens, setMaxTokens] = createSignal(getAISettings().maxTokens);
  const [topP, setTopP] = createSignal(getAISettings().topP);
  const [repeatPenalty, setRepeatPenalty] = createSignal(getAISettings().repeatPenalty);

  // Load available models on component mount
  createEffect(async () => {
    try {
      const result = await electrobun.rpc?.request.llamaListModels();
      if (result?.ok && result.models) {
        setAvailableModels(result.models);
      }
    } catch (error) {
      console.error("Error loading models:", error);
    }
  });

  // Load context file content on mount
  createEffect(async () => {
    if (!contextFilePath) return;
    
    console.log("AgentSlate: Loading initial context file from:", contextFilePath);
    
    try {
      const exists = await electrobun.rpc?.request.exists({ path: contextFilePath });
      console.log("AgentSlate: Context file exists on mount:", exists);
      
      if (exists) {
        const result = await electrobun.rpc?.request.readFile({ path: contextFilePath });
        console.log("AgentSlate: Initial context file content length:", result?.textContent?.length || 0);
        
        if (result?.textContent) {
          setContextContent(result.textContent);
          console.log("AgentSlate: Initial context content loaded:", result.textContent.substring(0, 100) + "...");
        }
      }
    } catch (error) {
      console.error("Error loading initial context file:", error);
    }
  });

  // Update conversation history when slate or current chat changes
  createEffect(() => {
    setChatHistories(getChatHistories());
    setConversationHistory(getCurrentMessages());
    setSelectedModel(getCurrentModel());
    
    // Update AI settings
    const aiSettings = getAISettings();
    setTemperature(aiSettings.temperature);
    setMaxTokens(aiSettings.maxTokens);
    setTopP(aiSettings.topP);
    setRepeatPenalty(aiSettings.repeatPenalty);
    
    // Reset context when slate changes
    setContextContent("");
  });

  // Update current conversation when currentChatId changes
  createEffect(() => {
    setConversationHistory(getCurrentMessages());
  });
  
  // Auto-scroll to bottom when conversation history changes
  createEffect(() => {
    conversationHistory(); // Track changes to conversation history
    setTimeout(scrollToBottom, 10); // Small delay to ensure DOM is updated
  });

  const saveChatHistoriesToSlate = (histories: ChatHistory[]) => {
    const slateData = slate();
    if (slateData?.type === "agent") {
      const updatedSlate = {
        ...slateData,
        config: {
          ...slateData.config,
          chatHistories: histories,
          model: selectedModel(),
          aiSettings: {
            temperature: temperature(),
            maxTokens: maxTokens(),
            topP: topP(),
            repeatPenalty: repeatPenalty(),
          },
          // Remove old conversationHistory field if it exists
          conversationHistory: undefined,
        },
      };
      
      // Update slate cache
      setState("slateCache", node.path + "/.colab.json", updatedSlate);
      
      // Save to file
      const configPath = node.path + "/.colab.json";
      const contents = JSON.stringify(updatedSlate, null, 2);
      electrobun.rpc?.request.writeFile({
        path: configPath,
        value: contents,
      });
    }
  };

  const saveAISettings = () => {
    // Save AI settings immediately when changed
    saveChatHistoriesToSlate(chatHistories());
  };

  const reloadContextFile = async () => {
    if (!contextFilePath) {
      console.log("AgentSlate: No context file path, skipping reload");
      return;
    }
    
    console.log("AgentSlate: Reloading context file from:", contextFilePath);
    
    try {
      const exists = await electrobun.rpc?.request.exists({ path: contextFilePath });
      console.log("AgentSlate: Context file exists (reload):", exists);
      
      if (exists) {
        const result = await electrobun.rpc?.request.readFile({ path: contextFilePath });
        console.log("AgentSlate: Context file content length (reload):", result?.textContent?.length || 0);
        console.log("AgentSlate: Context file content (reload):", JSON.stringify(result?.textContent));
        
        if (result?.textContent) {
          setContextContent(result.textContent);
          console.log("AgentSlate: Context content reloaded successfully");
        } else {
          setContextContent("");
          console.log("AgentSlate: Context file empty, cleared context");
        }
      } else {
        // File doesn't exist, clear context
        setContextContent("");
        console.log("AgentSlate: Context file not found, cleared context");
      }
    } catch (error) {
      console.error("Error reloading context file:", error);
    }
  };

  const updateCurrentChat = (messages: Message[]) => {
    const chatId = currentChatId();
    if (!chatId) return;

    const updatedHistories = chatHistories().map(chat => 
      chat.id === chatId 
        ? { ...chat, messages, updatedAt: Date.now() }
        : chat
    );
    
    setChatHistories(updatedHistories);
    setConversationHistory(messages);
    saveChatHistoriesToSlate(updatedHistories);
  };

  const generateChatTitle = (firstMessage: string): string => {
    // Generate a title from the first user message (truncated)
    const words = firstMessage.trim().split(' ').slice(0, 4);
    return words.join(' ') + (firstMessage.split(' ').length > 4 ? '...' : '');
  };

  const startNewChat = () => {
    const newChatId = `chat_${Date.now()}`;
    const newChat: ChatHistory = {
      id: newChatId,
      title: "New Chat",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const updatedHistories = [newChat, ...chatHistories()];
    setChatHistories(updatedHistories);
    setCurrentChatId(newChatId);
    setConversationHistory([]);
    saveChatHistoriesToSlate(updatedHistories);
    
    // Reload context file when starting new chat
    reloadContextFile();
  };

  const deleteChat = (chatId: string) => {
    const updatedHistories = chatHistories().filter(chat => chat.id !== chatId);
    setChatHistories(updatedHistories);
    
    // If we deleted the current chat, switch to another one or create new
    if (currentChatId() === chatId) {
      if (updatedHistories.length > 0) {
        setCurrentChatId(updatedHistories[0].id);
        setConversationHistory(updatedHistories[0].messages);
      } else {
        setCurrentChatId(null);
        setConversationHistory([]);
      }
    }
    
    saveChatHistoriesToSlate(updatedHistories);
  };

  const switchToChat = (chatId: string) => {
    setCurrentChatId(chatId);
    const chat = chatHistories().find(c => c.id === chatId);
    setConversationHistory(chat?.messages || []);
  };

  const sendMessage = async () => {
    if (!message().trim() || isLoading()) return;

    // If no current chat, create a new one
    if (!currentChatId()) {
      startNewChat();
    }

    const userMessage: Message = {
      role: "user",
      content: message().trim(),
      timestamp: Date.now(),
    };

    const newHistory = [...conversationHistory(), userMessage];
    setConversationHistory(newHistory);
    
    // Immediately update the chat history to show the user message
    updateCurrentChat(newHistory);
    
    // Update chat title if it's the first message in a new chat
    const currentChat = chatHistories().find(c => c.id === currentChatId());
    if (currentChat && currentChat.title === "New Chat" && newHistory.length === 1) {
      const updatedHistories = chatHistories().map(chat => 
        chat.id === currentChatId() 
          ? { ...chat, title: generateChatTitle(userMessage.content) }
          : chat
      );
      setChatHistories(updatedHistories);
    }

    setMessage("");
    setIsLoading(true);

    try {
      // Reload context file before each message to ensure latest content
      await reloadContextFile();
      
      // Convert conversation history to a proper prompt format
      // Only include recent history to avoid token limits and repetition issues
      const recentHistory = newHistory.slice(-6); // Keep last 6 messages (3 exchanges)
      
      let conversationPrompt = "";
      
      // Build system prompt with context if available
      let systemPrompt = "You are a helpful AI assistant.";
      const context = contextContent().trim();
      console.log("AgentSlate: Building prompt with context length:", context.length);
      console.log("AgentSlate: Context file path:", contextFilePath);
      console.log("AgentSlate: Full context content:", JSON.stringify(context));
      
      if (context) {
        systemPrompt += ` Here is your custom context and instructions:\n\n${context}\n\nPlease follow these instructions while being helpful and responsive.`;
        console.log("AgentSlate: System prompt with context:", systemPrompt.substring(0, 200) + "...");
      } else {
        console.log("AgentSlate: No context content, using default prompt");
      }
      
      // Build conversation prompt with clear boundaries
      conversationPrompt = `${systemPrompt}\n\n`;
      
      // Add conversation history
      recentHistory.slice(0, -1).forEach(msg => {
        if (msg.role === "user") {
          conversationPrompt += `User: ${msg.content}\n\n`;
        } else {
          conversationPrompt += `Assistant: ${msg.content}\n\n`;
        }
      });
      
      // Add current user message and prompt for response
      const currentMsg = recentHistory[recentHistory.length - 1];
      conversationPrompt += `User: ${currentMsg.content}\n\nAssistant:`;

      // Send to llama.cpp runner
      const response = await electrobun.rpc?.request.llamaCompletion({
        model: selectedModel(),
        prompt: conversationPrompt,
        options: {
          temperature: temperature(),
          max_tokens: maxTokens(),
          top_p: topP(),
          repeat_penalty: repeatPenalty(),
        },
      });

      if (response?.ok && response.response) {
        const assistantMessage: Message = {
          role: "assistant",
          content: response.response.trim(),
          timestamp: Date.now(),
        };

        const finalHistory = [...newHistory, assistantMessage];
        updateCurrentChat(finalHistory);
      } else if (response?.error) {
        throw new Error(response.error);
      }
    } catch (error) {
      console.error("Error generating response:", error);
      
      const errorMessage: Message = {
        role: "assistant",
        content: "Sorry, I encountered an error while generating a response. Please make sure your local AI model is running.",
        timestamp: Date.now(),
      };
      
      const finalHistory = [...newHistory, errorMessage];
      updateCurrentChat(finalHistory);
    }

    setIsLoading(false);
  };

  const clearCurrentChat = () => {
    if (currentChatId()) {
      updateCurrentChat([]);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style="height: 100%; display: flex; flex-direction: column; background: #1e1e1e">
      {/* Connection bar to match active tab */}
      
      <div style="display: flex; flex: 1; margin-top: 8px; background: #1e1e1e;">
        {/* Sidebar */}
        <Show when={showSidebar()}>
          <div style="width: 280px; background: #252525; border-right: 2px solid #1d1d1dff; box-shadow: inset -1px 0 0 #444; display: flex; flex-direction: column;">
          {/* Sidebar Header */}
          <div style="padding: 20px 16px; border-bottom: 2px solid #111; display: flex; align-items: center; justify-content: space-between; background: #1e1e1e; border-right: 1px solid #333;">
            <h4 style="margin: 0; color: #fff; font-size: 13px; font-weight: 500;">Chat History</h4>
            <button
              onClick={() => setShowSidebar(false)}
              style="background: none; border: none; color: #888; cursor: pointer; font-size: 16px; padding: 2px;"
              title="Hide sidebar"
            >
              ×
            </button>
          </div>
          
          {/* New Chat Button */}
          <div style="padding: 12px 16px; border-bottom: 1px solid #333;">
            <button
              onClick={startNewChat}
              style="width: 100%; background: #0066cc; border: none; color: white; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;"
            >
              + New Chat
            </button>
          </div>
          
          {/* Chat List */}
          <div style="flex: 1; overflow-y: auto;">
            <Show when={chatHistories().length === 0}>
              <div style="padding: 20px 16px; color: #888; text-align: center; font-size: 13px; font-style: italic;">
                No chat history yet
              </div>
            </Show>
            
            <For each={chatHistories()}>
              {(chat) => (
                <div
                  style={`padding: 12px 16px; border-bottom: 1px solid #2a2a2a; cursor: pointer; transition: background 0.15s; ${
                    currentChatId() === chat.id ? "background: #333;" : ""
                  }`}
                  onMouseEnter={(e) => {
                    if (currentChatId() !== chat.id) {
                      e.currentTarget.style.background = "#2a2a2a";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (currentChatId() !== chat.id) {
                      e.currentTarget.style.background = "transparent";
                    }
                  }}
                  onClick={() => switchToChat(chat.id)}
                >
                  <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <div style="flex: 1; min-width: 0;">
                      <div style="color: #fff; font-size: 13px; font-weight: 500; truncate; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        {chat.title}
                      </div>
                      <div style="color: #888; font-size: 11px; margin-top: 2px;">
                        {chat.messages.length} messages • {new Date(chat.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete chat "${chat.title}"?`)) {
                          deleteChat(chat.id);
                        }
                      }}
                      style="background: none; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 2px; opacity: 0.7;"
                      title="Delete chat"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Main Chat Area */}
      <div style="flex: 1; display: flex; flex-direction: column;">
        {/* Header */}
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 16px 16px; border-bottom: 2px solid #111; background: #1e1e1e;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <Show when={!showSidebar()}>
              <button
                onClick={() => setShowSidebar(true)}
                style="background: #555; border: 1px solid #666; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;"
                title="Show chat history"
              >
                ☰
              </button>
            </Show>
            <h3 style="margin: 0; color: #fff; font-size: 14px;">
              {slate()?.name || "AI Assistant"}
              <Show when={currentChatId()}>
                <span style="color: #888; font-weight: normal; margin-left: 8px;">
                  • {chatHistories().find(c => c.id === currentChatId())?.title || "New Chat"}
                </span>
              </Show>
            </h3>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <select
              value={selectedModel()}
              onChange={(e) => setSelectedModel(e.target.value)}
              style="background: #333; border: 1px solid #555; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; max-width: 200px;"
            >
              <Show
                when={availableModels().length > 0}
                fallback={
                  <option value={state.appSettings.llama.model}>
                    {state.appSettings.llama.model}
                  </option>
                }
              >
                <For each={availableModels()}>
                  {(model) => (
                    <option value={model.name} title={model.path}>
                      {model.name}
                    </option>
                  )}
                </For>
              </Show>
            </select>
            <Show when={currentChatId()}>
              <button
                onClick={clearCurrentChat}
                style="background: #555; border: 1px solid #666; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;"
                title="Clear current chat"
              >
                Clear
              </button>
            </Show>
            <button
              onClick={() => setShowSettings(!showSettings())}
              style={`background: ${showSettings() ? "#0066cc" : "#555"}; border: 1px solid ${showSettings() ? "#0066cc" : "#666"}; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;`}
              title="AI Settings"
            >
              ⚙️
            </button>
            <button
              onClick={reloadContextFile}
              style="background: #666; border: 1px solid #777; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;"
              title="Reload context file"
            >
              ↻
            </button>
            <button
              onClick={startNewChat}
              style="background: #0066cc; border: 1px solid #0066cc; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;"
              title="Start new chat"
            >
              New
            </button>
          </div>
        </div>

        {/* AI Settings Panel */}
        <Show when={showSettings()}>
          <div style="background: #252525; border-bottom: 1px solid #333; padding: 16px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
              <div>
                <label style="display: block; color: #ccc; font-size: 12px; margin-bottom: 4px; font-weight: 500;">
                  Temperature ({temperature()})
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature()}
                  onInput={(e) => {
                    setTemperature(parseFloat(e.target.value));
                    saveAISettings();
                  }}
                  style="width: 100%; background: #333; height: 4px; border-radius: 2px; outline: none;"
                />
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                  Controls randomness (0 = focused, 2 = creative)
                </div>
              </div>
              
              <div>
                <label style="display: block; color: #ccc; font-size: 12px; margin-bottom: 4px; font-weight: 500;">
                  Max Tokens ({maxTokens()})
                </label>
                <input
                  type="range"
                  min="100"
                  max="4000"
                  step="100"
                  value={maxTokens()}
                  onInput={(e) => {
                    setMaxTokens(parseInt(e.target.value));
                    saveAISettings();
                  }}
                  style="width: 100%; background: #333; height: 4px; border-radius: 2px; outline: none;"
                />
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                  Maximum response length
                </div>
              </div>
              
              <div>
                <label style="display: block; color: #ccc; font-size: 12px; margin-bottom: 4px; font-weight: 500;">
                  Top P ({topP()})
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={topP()}
                  onInput={(e) => {
                    setTopP(parseFloat(e.target.value));
                    saveAISettings();
                  }}
                  style="width: 100%; background: #333; height: 4px; border-radius: 2px; outline: none;"
                />
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                  Nucleus sampling threshold
                </div>
              </div>
              
              <div>
                <label style="display: block; color: #ccc; font-size: 12px; margin-bottom: 4px; font-weight: 500;">
                  Repeat Penalty ({repeatPenalty()})
                </label>
                <input
                  type="range"
                  min="1"
                  max="1.5"
                  step="0.05"
                  value={repeatPenalty()}
                  onInput={(e) => {
                    setRepeatPenalty(parseFloat(e.target.value));
                    saveAISettings();
                  }}
                  style="width: 100%; background: #333; height: 4px; border-radius: 2px; outline: none;"
                />
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                  Reduces repetitive responses
                </div>
              </div>
            </div>
            
            <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
              <button
                onClick={() => {
                  setTemperature(0.7);
                  setMaxTokens(2000);
                  setTopP(0.9);
                  setRepeatPenalty(1.1);
                  saveAISettings();
                }}
                style="background: #555; border: 1px solid #666; color: #fff; padding: 4px 12px; border-radius: 4px; font-size: 11px; cursor: pointer;"
                title="Reset to defaults"
              >
                Reset Defaults
              </button>
            </div>
          </div>
        </Show>

        {/* Conversation History */}
        <div ref={chatContainerRef} style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px;">
          <Show when={conversationHistory().length === 0}>
            <div style="color: #888; text-align: center; margin-top: 40px; font-style: italic;">
              <Show when={!currentChatId()}>
                Click "New Chat" to start a conversation with your AI assistant
              </Show>
              <Show when={currentChatId()}>
                Start typing to begin this conversation
              </Show>
            </div>
          </Show>
          
          <For each={conversationHistory()}>
            {(msg) => (
              <div
                style={`display: flex; ${
                  msg.role === "user" ? "justify-content: flex-end" : "justify-content: flex-start"
                }`}
              >
                <div
                  style={`max-width: 80%; padding: 12px 16px; border-radius: 12px; ${
                    msg.role === "user"
                      ? "background: #0066cc; color: white;"
                      : "background: #333; color: #fff; border: 1px solid #555;"
                  }`}
                >
                  <div style="white-space: pre-wrap; word-wrap: break-word; line-height: 1.4; user-select: text; -webkit-user-select: text; -moz-user-select: text; -ms-user-select: text; cursor: text;">
                    {msg.content}
                  </div>
                  <div
                    style={`font-size: 11px; margin-top: 8px; opacity: 0.7; ${
                      msg.role === "user" ? "color: #b3d9ff;" : "color: #aaa;"
                    }`}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            )}
          </For>

          <Show when={isLoading()}>
            <div style="display: flex; justify-content: flex-start;">
              <div style="background: #333; color: #fff; border: 1px solid #555; padding: 12px 16px; border-radius: 12px;">
                <div style="color: #888; font-style: italic;">
                  Generating response...
                </div>
              </div>
            </div>
          </Show>
        </div>

        {/* Message Input */}
        <div style="padding: 16px; border-top: 1px solid #333; background: #2d2d2d;">
          <div style="display: flex; gap: 12px; align-items: flex-end;">
            <textarea
              value={message()}
              onInput={(e) => setMessage(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
              style="flex: 1; background: #1e1e1e; border: 1px solid #555; color: #fff; padding: 12px; border-radius: 8px; resize: none; min-height: 20px; max-height: 120px; font-family: inherit; font-size: 14px; line-height: 1.4;"
              rows="1"
            />
            <button
              onClick={sendMessage}
              disabled={!message().trim() || isLoading()}
              style={`background: ${
                !message().trim() || isLoading() ? "#555" : "#0066cc"
              }; border: none; color: white; padding: 12px 20px; border-radius: 8px; cursor: ${
                !message().trim() || isLoading() ? "not-allowed" : "pointer"
              }; font-size: 14px; font-weight: 500;`}
            >
              Send
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
};