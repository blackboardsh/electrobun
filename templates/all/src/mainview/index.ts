import Electrobun, { Electroview } from "electrobun/view";

type TemplateStatus =
	| "pending"
	| "downloading"
	| "installing"
	| "prepared"
	| "starting"
	| "ready"
	| "failed"
	| "stopping"
	| "stopped";

type LogStream = "stdout" | "stderr" | "system";

type TemplateSnapshot = {
	id: string;
	name: string;
	description: string;
	mainProcess: string;
	status: TemplateStatus;
	detail?: string;
	directory?: string;
	lastError?: string;
	attemptCount: number;
	lastAttemptStartedAt?: string;
	readyAfterRetry?: boolean;
	attempts: Array<{
		number: number;
		startedAt: string;
		endedAt?: string;
		outcome?: string;
		error?: string;
	}>;
};

type LogEntry = {
	sequence: number;
	templateId: string;
	stream: LogStream;
	attempt: number;
	text: string;
	timestamp: string;
};

type Snapshot = {
	catalogVersion: string;
	channel: string;
	root: string;
	templates: TemplateSnapshot[];
	logs: LogEntry[];
};

type AcceptedResponse = { accepted: boolean };

type HutchStatusSummary = {
	homePath: string;
	homeSource: string;
	productCount: number;
	productInstallCount: number;
	productsBytes: number;
	toolchainCount: number;
	toolchainsBytes: number;
	cacheObjectCount: number;
	cacheBytes: number;
	prunableObjectCount: number;
	totalBytes: number;
	issueCount: number;
};

type HutchStoreStatus =
	| { ok: true; summary: HutchStatusSummary }
	| { ok: false; message: string };

type TemplateQARPC = {
	bun: {
		requests: {
			getSnapshot: { params: {}; response: Snapshot };
			startAll: { params: {}; response: AcceptedResponse };
			stopAll: { params: {}; response: AcceptedResponse };
			installTemplate: { params: { id: string }; response: AcceptedResponse };
			launchTemplate: { params: { id: string }; response: AcceptedResponse };
			stopTemplate: { params: { id: string }; response: AcceptedResponse };
			getHutchStatus: { params: {}; response: HutchStoreStatus };
			pruneHutchCache: {
				params: { dryRun: boolean };
				response: AcceptedResponse;
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			snapshot: Snapshot;
			log: LogEntry;
		};
	};
};

const MAX_RENDERED_LOGS = 1_500;

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`Missing required element #${id}`);
	return found as T;
}

const releaseLabel = element<HTMLSpanElement>("release-label");
const connectionBadge = element<HTMLDivElement>("connection-badge");
const connectionLabel = element<HTMLSpanElement>("connection-label");
const startAllButton = element<HTMLButtonElement>("start-all");
const stopAllButton = element<HTMLButtonElement>("stop-all");
const totalCount = element<HTMLSpanElement>("total-count");
const readyCount = element<HTMLSpanElement>("ready-count");
const activeCount = element<HTMLSpanElement>("active-count");
const failedCount = element<HTMLSpanElement>("failed-count");
const stoppedCount = element<HTMLSpanElement>("stopped-count");
const retryCount = element<HTMLSpanElement>("retry-count");
const summaryProgress = element<HTMLSpanElement>("summary-progress-bar");
const templateSummary = element<HTMLParagraphElement>("template-summary");
const templateSearch = element<HTMLInputElement>("template-search");
const templateList = element<HTMLDivElement>("template-list");
const templateFilter = element<HTMLSelectElement>("template-filter");
const streamFilter = element<HTMLSelectElement>("stream-filter");
const logSearch = element<HTMLInputElement>("log-search");
const followLogs = element<HTMLInputElement>("follow-logs");
const clearLogsButton = element<HTMLButtonElement>("clear-logs");
const copyLogsButton = element<HTMLButtonElement>("copy-logs");
const exportLogsButton = element<HTMLButtonElement>("export-logs");
const logOutput = element<HTMLDivElement>("log-output");
const visibleLogCount = element<HTMLSpanElement>("visible-log-count");
const installRoot = element<HTMLElement>("install-root");
const toast = element<HTMLDivElement>("toast");
const storeBody = element<HTMLDivElement>("store-body");
const refreshStatusButton = element<HTMLButtonElement>("refresh-status");
const prunePreviewButton = element<HTMLButtonElement>("prune-preview");
const pruneRunButton = element<HTMLButtonElement>("prune-run");

let snapshot: Snapshot = {
	catalogVersion: "",
	channel: "stable",
	root: "",
	templates: [],
	logs: [],
};
let retainedLogs: LogEntry[] = [];
const seenLogKeys = new Set<string>();
const expandedAttemptHistories = new Set<string>();
let globalActionPending = false;
const templateActionsPending = new Set<string>();
let logRenderFrame: number | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const rpc = Electroview.defineRPC<TemplateQARPC>({
	maxRequestTime: 30_000,
	handlers: {
		requests: {},
		messages: {
			snapshot: (nextSnapshot: Snapshot) => applySnapshot(nextSnapshot),
			log: (entry: LogEntry) => appendLog(entry),
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

function setConnection(state: "connecting" | "online" | "error", label: string): void {
	connectionBadge.dataset.state = state;
	connectionLabel.textContent = label;
}

function showToast(message: string, isError = false): void {
	if (toastTimer) clearTimeout(toastTimer);
	toast.textContent = message;
	toast.classList.toggle("error", isError);
	toast.classList.add("visible");
	toastTimer = setTimeout(() => toast.classList.remove("visible"), 3_600);
}

function isLogEntry(value: LogEntry): boolean {
	return (
		Number.isFinite(value.sequence) &&
		typeof value.templateId === "string" &&
		(value.stream === "stdout" || value.stream === "stderr" || value.stream === "system") &&
		Number.isFinite(value.attempt) &&
		typeof value.text === "string" &&
		typeof value.timestamp === "string"
	);
}

function logKey(entry: LogEntry): string {
	return `${entry.templateId}\u0000${entry.attempt}\u0000${entry.sequence}\u0000${entry.stream}\u0000${entry.timestamp}\u0000${entry.text}`;
}

function mergeLogs(entries: LogEntry[]): void {
	for (const entry of entries) {
		if (!isLogEntry(entry)) continue;
		const key = logKey(entry);
		if (seenLogKeys.has(key)) continue;
		seenLogKeys.add(key);
		retainedLogs.push(entry);
	}
	retainedLogs.sort((left, right) => left.sequence - right.sequence);
}

function applySnapshot(nextSnapshot: Snapshot): void {
	if (!nextSnapshot || !Array.isArray(nextSnapshot.templates) || !Array.isArray(nextSnapshot.logs)) {
		setConnection("error", "Invalid snapshot");
		showToast("The runner returned an invalid snapshot.", true);
		return;
	}

	snapshot = {
		catalogVersion: String(nextSnapshot.catalogVersion ?? "unknown"),
		channel: String(nextSnapshot.channel ?? "stable"),
		root: String(nextSnapshot.root ?? ""),
		templates: nextSnapshot.templates,
		logs: [],
	};
	mergeLogs(nextSnapshot.logs);
	setConnection("online", "Runner online");
	renderSnapshot();
	scheduleLogRender();
}

function appendLog(entry: LogEntry): void {
	mergeLogs([entry]);
	scheduleLogRender();
}

function statusLabel(status: TemplateStatus): string {
	switch (status) {
		case "downloading":
			return "Downloading";
		case "installing":
			return "Installing";
		case "prepared":
			return "Installed";
		case "starting":
			return "Starting";
		case "ready":
			return "Ready";
		case "failed":
			return "Failed";
		case "stopping":
			return "Stopping";
		case "stopped":
			return "Stopped";
		case "pending":
		default:
			return "Pending";
	}
}

function statusIsActive(status: TemplateStatus): boolean {
	return status === "downloading" || status === "installing" || status === "starting" || status === "ready";
}

type TemplateAction = "install" | "launch" | "stop";

function statusIsBusy(status: TemplateStatus): boolean {
	return status === "downloading" || status === "installing" || status === "starting";
}

function createButton(
	label: string,
	className: string,
	action: TemplateAction,
	template: TemplateSnapshot,
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `button ${className}`;
	button.dataset.action = action;
	button.dataset.templateId = template.id;
	button.textContent = label;
	button.disabled =
		globalActionPending ||
		templateActionsPending.has(template.id) ||
		(action === "stop" && !statusIsActive(template.status) && template.status !== "stopping") ||
		(action !== "stop" && statusIsBusy(template.status));
	return button;
}

function createTemplateCard(template: TemplateSnapshot): HTMLElement {
	const card = document.createElement("article");
	card.className = "template-card";
	card.dataset.status = template.status;
	card.dataset.passedAfterRetry = String(template.readyAfterRetry === true);
	card.dataset.templateId = template.id;

	const header = document.createElement("div");
	header.className = "template-card-header";

	const titleGroup = document.createElement("div");
	titleGroup.className = "template-card-title";
	const name = document.createElement("div");
	name.className = "template-name";
	name.textContent = template.name || template.id;
	const id = document.createElement("div");
	id.className = "template-id";
	id.textContent = template.id;
	titleGroup.append(name, id);

	const status = document.createElement("span");
	status.className = "status-label";
	const statusDot = document.createElement("span");
	statusDot.className = "status-dot";
	statusDot.setAttribute("aria-hidden", "true");
	const statusText = document.createElement("span");
	statusText.textContent = statusLabel(template.status);
	status.append(statusDot, statusText);
	header.append(titleGroup, status);

	const description = document.createElement("p");
	description.className = "template-description";
	description.textContent = template.description || "No template description provided.";

	card.append(header, description);
	if (template.readyAfterRetry) {
		const retrySuccess = document.createElement("span");
		retrySuccess.className = "retry-success-badge";
		retrySuccess.textContent = "Passed after retry";
		card.append(retrySuccess);
	}

	const detailText = template.lastError || template.detail;
	if (detailText) {
		const detail = document.createElement("div");
		detail.className = `template-detail${template.lastError ? " template-error" : ""}`;
		detail.textContent = detailText;
		if (template.directory) detail.title = template.directory;
		card.append(detail);
	}

	const meta = document.createElement("div");
	meta.className = "template-meta";
	const processInfo = document.createElement("div");
	processInfo.className = "template-process-info";
	const process = document.createElement("span");
	process.className = "process-badge";
	process.textContent = template.mainProcess || "unknown process";
	process.title = template.directory || `Main process: ${template.mainProcess}`;
	const attempt = document.createElement("span");
	attempt.className = "attempt-badge";
	const attemptCount = Number.isFinite(template.attemptCount) ? template.attemptCount : template.attempts?.length ?? 0;
	attempt.textContent = `${attemptCount} ${attemptCount === 1 ? "attempt" : "attempts"}`;
	if (template.lastAttemptStartedAt) {
		attempt.title = `Latest attempt started ${formatFullTimestamp(template.lastAttemptStartedAt)}`;
	}
	processInfo.append(process, attempt);

	const actions = document.createElement("div");
	actions.className = "template-actions";
	const installLabel = template.status === "prepared" ? "Reinstall" : "Install";
	const launchLabel = statusIsActive(template.status) ? "Relaunch" : "Launch";
	actions.append(
		createButton("Stop", "button-danger", "stop", template),
		createButton(installLabel, "button-quiet", "install", template),
		createButton(launchLabel, "button-secondary", "launch", template),
	);
	meta.append(processInfo, actions);
	card.append(meta);

	if (Array.isArray(template.attempts) && template.attempts.length > 0) {
		const history = document.createElement("details");
		history.className = "attempt-history";
		history.open = expandedAttemptHistories.has(template.id);
		history.addEventListener("toggle", () => {
			if (history.open) expandedAttemptHistories.add(template.id);
			else expandedAttemptHistories.delete(template.id);
		});
		const summary = document.createElement("summary");
		const latestTime = template.lastAttemptStartedAt
			? ` · latest ${formatFullTimestamp(template.lastAttemptStartedAt)}`
			: "";
		summary.textContent = `Attempt history${latestTime}`;
		const list = document.createElement("ol");
		list.className = "attempt-list";
		for (const item of [...template.attempts].sort((left, right) => right.number - left.number)) {
			const row = document.createElement("li");
			row.className = "attempt-item";
			row.dataset.outcome = item.outcome?.toLocaleLowerCase() ?? "running";
			const number = document.createElement("span");
			number.className = "attempt-number";
			number.textContent = `#${item.number}`;
			const time = document.createElement("span");
			time.className = "attempt-time";
			time.textContent = formatAttemptRange(item.startedAt, item.endedAt);
			time.title = `${formatFullTimestamp(item.startedAt)}${item.endedAt ? ` – ${formatFullTimestamp(item.endedAt)}` : ""}`;
			const outcome = document.createElement("span");
			outcome.className = "attempt-outcome";
			outcome.textContent = item.outcome || "Running";
			row.append(number, time, outcome);
			if (item.error) {
				const error = document.createElement("span");
				error.className = "attempt-error";
				error.textContent = item.error;
				row.append(error);
			}
			list.append(row);
		}
		history.append(summary, list);
		card.append(history);
	}
	return card;
}

function renderSummary(): void {
	const counts = new Map<TemplateStatus, number>();
	for (const template of snapshot.templates) {
		counts.set(template.status, (counts.get(template.status) ?? 0) + 1);
	}
	const ready = counts.get("ready") ?? 0;
	const active =
		(counts.get("downloading") ?? 0) +
		(counts.get("installing") ?? 0) +
		(counts.get("starting") ?? 0) +
		(counts.get("stopping") ?? 0);
	const stopped =
		(counts.get("pending") ?? 0) +
		(counts.get("stopped") ?? 0) +
		(counts.get("prepared") ?? 0);

	totalCount.textContent = String(snapshot.templates.length);
	readyCount.textContent = String(ready);
	activeCount.textContent = String(active);
	failedCount.textContent = String(counts.get("failed") ?? 0);
	stoppedCount.textContent = String(stopped);
	retryCount.textContent = String(
		snapshot.templates.filter((template) => template.readyAfterRetry).length,
	);
	summaryProgress.style.width = snapshot.templates.length
		? `${Math.round((ready / snapshot.templates.length) * 100)}%`
		: "0%";
}

function renderTemplates(): void {
	const query = templateSearch.value.trim().toLocaleLowerCase();
	const filtered = snapshot.templates.filter((template) => {
		if (!query) return true;
		return [template.id, template.name, template.description, template.mainProcess].some((value) =>
			value.toLocaleLowerCase().includes(query),
		);
	});

	templateList.replaceChildren();
	if (filtered.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty-state";
		const mark = document.createElement("div");
		mark.className = "empty-state-mark";
		mark.setAttribute("aria-hidden", "true");
		mark.textContent = snapshot.templates.length ? "⌕" : "…";
		const title = document.createElement("strong");
		title.textContent = snapshot.templates.length ? "No matching templates" : "Loading templates";
		const description = document.createElement("span");
		description.textContent = snapshot.templates.length
			? "Try a template name, id, or main-process type."
			: "The selected release catalog and local project state will appear here.";
		empty.append(mark, title, description);
		templateList.append(empty);
	} else {
		const fragment = document.createDocumentFragment();
		for (const template of filtered) fragment.append(createTemplateCard(template));
		templateList.append(fragment);
	}

	templateSummary.textContent = query
		? `${filtered.length} of ${snapshot.templates.length} templates shown`
		: snapshot.templates.length > 0 &&
				snapshot.templates.every(({ status }) => status === "pending")
			? `${snapshot.templates.length} templates pending · press Install all to begin`
			: `${snapshot.templates.length} projects · setup and builds are serialized`;
}

function renderTemplateFilter(): void {
	const selected = templateFilter.value;
	const fragment = document.createDocumentFragment();
	const aggregateOption = document.createElement("option");
	aggregateOption.value = "all";
	aggregateOption.textContent = "All templates";
	fragment.append(aggregateOption);
	for (const template of snapshot.templates) {
		const option = document.createElement("option");
		option.value = template.id;
		option.textContent = template.name || template.id;
		fragment.append(option);
	}
	templateFilter.replaceChildren(fragment);
	templateFilter.value = snapshot.templates.some((template) => template.id === selected) ? selected : "all";
}

function renderSnapshot(): void {
	releaseLabel.textContent = `${snapshot.channel} · ${snapshot.catalogVersion}`;
	installRoot.textContent = snapshot.root || "Not materialized yet";
	installRoot.title = snapshot.root;
	const orchestrationInProgress = snapshot.templates.some((template) =>
		["downloading", "installing", "starting", "stopping"].includes(
			template.status,
		),
	);
	startAllButton.disabled =
		globalActionPending ||
		snapshot.templates.length === 0 ||
		orchestrationInProgress;
	stopAllButton.disabled = globalActionPending || !snapshot.templates.some((template) => statusIsActive(template.status));
	renderSummary();
	renderTemplates();
	renderTemplateFilter();
}

function scheduleLogRender(): void {
	if (logRenderFrame !== null) return;
	logRenderFrame = requestAnimationFrame(() => {
		logRenderFrame = null;
		renderLogs();
	});
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "--:--:--";
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatFullTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp || "unknown time";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatAttemptRange(startedAt: string, endedAt?: string): string {
	const start = formatFullTimestamp(startedAt);
	if (!endedAt) return `${start} – running`;
	const startDate = new Date(startedAt);
	const endDate = new Date(endedAt);
	if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
		return `${start} – ${formatFullTimestamp(endedAt)}`;
	}
	const durationSeconds = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 1_000));
	return `${start} · ${durationSeconds}s`;
}

function renderLogs(): void {
	const shouldStick = followLogs.checked && logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 64;
	const selectedTemplate = templateFilter.value;
	const selectedStream = streamFilter.value;
	const query = logSearch.value.trim().toLocaleLowerCase();
	const filtered = retainedLogs.filter((entry) => {
		return (
			(selectedTemplate === "all" || entry.templateId === selectedTemplate) &&
			(selectedStream === "all" || entry.stream === selectedStream) &&
			(!query || entry.text.toLocaleLowerCase().includes(query))
		);
	});
	const displayed = filtered.slice(-MAX_RENDERED_LOGS);

	logOutput.replaceChildren();
	if (displayed.length === 0) {
		const empty = document.createElement("div");
		empty.className = "log-empty";
		const mark = document.createElement("span");
		mark.setAttribute("aria-hidden", "true");
		mark.textContent = "›_";
		const message = document.createTextNode(retainedLogs.length ? "No output matches these filters" : "No output yet");
		empty.append(mark, message);
		logOutput.append(empty);
	} else {
		const fragment = document.createDocumentFragment();
		for (const entry of displayed) {
			const row = document.createElement("div");
			row.className = "log-row";
			row.dataset.stream = entry.stream;

			const time = document.createElement("span");
			time.className = "log-time";
			time.textContent = formatTimestamp(entry.timestamp);
			time.title = entry.timestamp;

			const template = document.createElement("span");
			template.className = "log-template";
			template.textContent = entry.templateId || "runner";
			template.title = entry.templateId || "runner";

			const stream = document.createElement("span");
			stream.className = "log-stream";
			stream.textContent = entry.stream;

			const attempt = document.createElement("span");
			attempt.className = "log-attempt";
			attempt.textContent = `#${entry.attempt}`;
			attempt.title = `Attempt ${entry.attempt}`;

			const text = document.createElement("span");
			text.className = "log-text";
			text.textContent = entry.text;

			row.append(time, template, attempt, stream, text);
			fragment.append(row);
		}
		logOutput.append(fragment);
	}

	visibleLogCount.textContent = String(filtered.length);
	const hasLogs = retainedLogs.length > 0;
	copyLogsButton.disabled = !hasLogs;
	exportLogsButton.disabled = !hasLogs;
	clearLogsButton.disabled = !hasLogs;
	visibleLogCount.title =
		filtered.length > MAX_RENDERED_LOGS
			? `Showing the newest ${MAX_RENDERED_LOGS.toLocaleString()} entries`
			: `${filtered.length.toLocaleString()} entries`;
	if (shouldStick || (followLogs.checked && displayed.length <= 1)) {
		logOutput.scrollTop = logOutput.scrollHeight;
	}
}

async function runGlobalAction(kind: "start" | "stop"): Promise<void> {
	if (globalActionPending) return;
	globalActionPending = true;
	renderSnapshot();
	try {
		const response =
			kind === "start"
				? await electrobun.rpc!.request.startAll({})
				: await electrobun.rpc!.request.stopAll({});
		if (!response.accepted) throw new Error(`The runner declined the ${kind}-all request.`);
		setConnection("online", "Runner online");
		showToast(
			kind === "start"
				? "Install all queued. Projects install in sequence, then launch in dev mode."
				: "Stop-all queued.",
		);
	} catch (error) {
		setConnection("error", "Runner error");
		showToast(error instanceof Error ? error.message : `Unable to ${kind} all templates.`, true);
	} finally {
		globalActionPending = false;
		renderSnapshot();
	}
}

const TEMPLATE_ACTION_LABELS: Record<TemplateAction, string> = {
	install: "Install",
	launch: "Launch",
	stop: "Stop",
};

async function runTemplateAction(id: string, kind: TemplateAction): Promise<void> {
	if (templateActionsPending.has(id) || globalActionPending) return;
	const template = snapshot.templates.find((candidate) => candidate.id === id);
	if (!template) return;
	templateActionsPending.add(id);
	renderTemplates();
	try {
		const response =
			kind === "install"
				? await electrobun.rpc!.request.installTemplate({ id })
				: kind === "launch"
					? await electrobun.rpc!.request.launchTemplate({ id })
					: await electrobun.rpc!.request.stopTemplate({ id });
		if (!response.accepted) throw new Error(`The runner declined the ${kind} request for ${template.name}.`);
		setConnection("online", "Runner online");
		showToast(
			kind === "install"
				? `Install queued for ${template.name}. Nothing is launched until you press Launch.`
				: `${TEMPLATE_ACTION_LABELS[kind]} queued for ${template.name}.`,
		);
	} catch (error) {
		setConnection("error", "Runner error");
		showToast(error instanceof Error ? error.message : `Unable to ${kind} ${template.name}.`, true);
	} finally {
		templateActionsPending.delete(id);
		renderTemplates();
	}
}

startAllButton.addEventListener("click", () => void runGlobalAction("start"));
stopAllButton.addEventListener("click", () => void runGlobalAction("stop"));
templateSearch.addEventListener("input", renderTemplates);
templateFilter.addEventListener("change", scheduleLogRender);
streamFilter.addEventListener("change", scheduleLogRender);
logSearch.addEventListener("input", scheduleLogRender);
followLogs.addEventListener("change", () => {
	if (followLogs.checked) logOutput.scrollTop = logOutput.scrollHeight;
});

templateList.addEventListener("click", (event) => {
	const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action][data-template-id]");
	if (!button || button.disabled) return;
	const id = button.dataset.templateId;
	const action = button.dataset.action;
	if (id && (action === "install" || action === "launch" || action === "stop")) {
		void runTemplateAction(id, action);
	}
});

clearLogsButton.addEventListener("click", () => {
	retainedLogs = [];
	renderLogs();
	showToast("Output cleared locally. New output will continue to appear.");
});

function serializeAllLogs(): string {
	return retainedLogs
		.map((entry) => {
			const prefix = `[${entry.timestamp}] [${entry.templateId || "runner"} #${entry.attempt}] [${entry.stream}]`;
			return `${prefix} ${entry.text}`;
		})
		.join("\n");
}

async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("Clipboard access is unavailable.");
}

copyLogsButton.addEventListener("click", async () => {
	try {
		await copyText(serializeAllLogs());
		showToast(`Copied ${retainedLogs.length.toLocaleString()} log entries.`);
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Unable to copy logs.", true);
	}
});

exportLogsButton.addEventListener("click", () => {
	const blob = new Blob([serializeAllLogs()], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	const version = snapshot.catalogVersion.replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	link.href = url;
	link.download = `electrobun-template-qa-${version}-${timestamp}.log`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
	showToast(`Exported ${retainedLogs.length.toLocaleString()} log entries.`);
});

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${BYTE_UNITS[unit]}`;
}

function renderStoreMessage(message: string, quiet = false): void {
	const paragraph = document.createElement("p");
	paragraph.className = `store-message${quiet ? " store-message-quiet" : ""}`;
	paragraph.textContent = message;
	storeBody.replaceChildren(paragraph);
}

function renderStoreSummary(summary: HutchStatusSummary): void {
	const stats: Array<[string, string, string?]> = [
		["Total", formatByteSize(summary.totalBytes)],
		[
			"Products",
			formatByteSize(summary.productsBytes),
			`${summary.productCount} products · ${summary.productInstallCount} installs`,
		],
		[
			"Toolchains",
			formatByteSize(summary.toolchainsBytes),
			`${summary.toolchainCount} toolchains`,
		],
		[
			"Cache",
			`${summary.cacheObjectCount} objects`,
			`${formatByteSize(summary.cacheBytes)} · ${summary.prunableObjectCount} unreachable`,
		],
	];
	if (summary.issueCount > 0) stats.push(["Issues", String(summary.issueCount)]);

	const fragment = document.createDocumentFragment();
	for (const [label, value, title] of stats) {
		const stat = document.createElement("div");
		stat.className = "store-stat";
		const statValue = document.createElement("span");
		statValue.className = "store-stat-value";
		statValue.textContent = value;
		const statLabel = document.createElement("span");
		statLabel.className = "store-stat-label";
		statLabel.textContent = label;
		if (title) stat.title = title;
		stat.append(statValue, statLabel);
		fragment.append(stat);
	}
	const home = document.createElement("div");
	home.className = "store-home";
	home.textContent = `${summary.homePath} (${summary.homeSource})`;
	home.title = summary.homePath;
	fragment.append(home);
	storeBody.replaceChildren(fragment);
}

let storeStatusPending = false;

async function refreshStoreStatus(announce = false): Promise<void> {
	if (storeStatusPending) return;
	storeStatusPending = true;
	refreshStatusButton.disabled = true;
	try {
		const status = await electrobun.rpc!.request.getHutchStatus({});
		if (status && status.ok === true) {
			renderStoreSummary(status.summary);
			if (announce) showToast("Hutch store status refreshed.");
		} else {
			renderStoreMessage(
				status?.message || "Status unavailable — hutch returned no details.",
			);
		}
	} catch (error) {
		renderStoreMessage(
			error instanceof Error ? error.message : "Could not read the Hutch store status.",
		);
	} finally {
		storeStatusPending = false;
		refreshStatusButton.disabled = false;
	}
}

// The real prune requires a dry-run preview first, then a second confirming click.
let pruneConfirmTimer: ReturnType<typeof setTimeout> | null = null;
let pruneConfirmArmed = false;

function resetPruneConfirm(): void {
	if (pruneConfirmTimer) clearTimeout(pruneConfirmTimer);
	pruneConfirmTimer = null;
	pruneConfirmArmed = false;
	pruneRunButton.textContent = "Prune";
}

async function requestPrune(dryRun: boolean): Promise<void> {
	const response = await electrobun.rpc!.request.pruneHutchCache({ dryRun });
	if (!response.accepted) throw new Error("The runner declined the prune request.");
}

refreshStatusButton.addEventListener("click", () => void refreshStoreStatus(true));

prunePreviewButton.addEventListener("click", async () => {
	prunePreviewButton.disabled = true;
	try {
		await requestPrune(true);
		pruneRunButton.disabled = false;
		resetPruneConfirm();
		showToast("Prune preview running — output appears in the log pane.");
		templateFilter.value = "all";
		scheduleLogRender();
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Unable to preview the prune.", true);
	} finally {
		prunePreviewButton.disabled = false;
	}
});

pruneRunButton.addEventListener("click", async () => {
	if (!pruneConfirmArmed) {
		pruneConfirmArmed = true;
		pruneRunButton.textContent = "Confirm prune";
		if (pruneConfirmTimer) clearTimeout(pruneConfirmTimer);
		pruneConfirmTimer = setTimeout(resetPruneConfirm, 8_000);
		showToast("Click again within 8 seconds to delete unreachable store objects.");
		return;
	}
	resetPruneConfirm();
	pruneRunButton.disabled = true;
	try {
		await requestPrune(false);
		showToast("Prune running — output appears in the log pane.");
		scheduleLogRender();
		setTimeout(() => void refreshStoreStatus(), 4_000);
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Unable to prune the store.", true);
		pruneRunButton.disabled = false;
	}
});

async function loadInitialSnapshot(): Promise<void> {
	setConnection("connecting", "Connecting");
	try {
		applySnapshot(await electrobun.rpc!.request.getSnapshot({}));
	} catch (error) {
		setConnection("error", "Runner unavailable");
		showToast(error instanceof Error ? error.message : "Could not connect to the template runner.", true);
	}
}

void loadInitialSnapshot();
void refreshStoreStatus();
