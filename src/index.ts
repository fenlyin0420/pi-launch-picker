/**
 * Launch Picker — configure a session before the conversation starts.
 *
 * Manages three things:
 * - Active tool set (pi.setActiveTools), including the fully-clean "(none)" state.
 * - System prompt: replaced wholesale per turn via before_agent_start, from
 *   preset files in ~/.pi/agent/system-prompts/*.md. Special presets:
 *   "(default)" = pi's built-in prompt, "(empty)" = no system prompt, so the
 *   user message is the only prompt content.
 * - Named profiles persisted to ~/.pi/agent/launch-profiles.json, each bundling
 *   a tool set and a prompt preset.
 *
 * Behavior:
 * - session_start applies, in order: --lp-profile <name> > the profile stored
 *   in the session entry (survives /resume) > "last" from the profiles file.
 *   Only when nothing is saved and the UI is a real terminal does the
 *   interactive picker run: profile -> (optional custom flow) tools -> prompt.
 *
 * Commands:
 * - /lpick            open the interactive picker
 * - /lprofile [name]  apply a profile; no argument opens the picker;
 *                     /lprofile (none) clears back to defaults
 * - /lprompt [name]   set the system prompt preset ("(default)", "(empty)",
 *                     or a preset name); no argument opens a selector
 * - /ltools <spec>    set active tools: "all", "none", or a csv of tool names
 * - /lsave <name>     save current tools + prompt as a named profile
 * - /lstate [prompt]  show session state: active tools, skills, extensions,
 *                     system prompt (with "prompt" argument: dump full prompt)
 *
 * Shortcut: ctrl+shift+l opens the picker.
 *
 * App (RPC) integration:
 * - Dialogs degrade to extension_ui_request (select/input), which the app
 *   answers over extension_ui_response.
 * - The app can apply configurations without any dialog, e.g.:
 *     {"type":"prompt","message":"/lprofile clean"}
 *     {"type":"prompt","message":"/ltools read,bash,edit"}
 *     {"type":"prompt","message":"/lprompt research"}
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface Profile {
	/** Tools to activate (replaces the active set). Omitted: tools untouched. */
	tools?: string[];
	/** Prompt preset name, or "(default)" / "(empty)". Omitted: prompt untouched. */
	prompt?: string;
}

interface ProfilesFile {
	last?: string;
	profiles: Record<string, Profile>;
}

const DEFAULT_PROMPT = "(default)";
const EMPTY_PROMPT = "(empty)";
const NONE_CHOICE = "(none)";
const CUSTOM_CHOICE = "(new custom…)";

const PROFILES_FILE = join(getAgentDir(), "launch-profiles.json");
const PROMPTS_DIR = join(getAgentDir(), "system-prompts");

class ToolMultiSelect implements Component {
	private cursor = 0;
	private scrollTop = 0;
	private visibleRows = 12;
	private names: string[];
	private selected: Set<string>;
	private theme: Theme;
	private resolve: (result: string[] | null) => void;

	constructor(
		names: string[],
		selected: Set<string>,
		theme: Theme,
		resolve: (result: string[] | null) => void,
	) {
		this.names = names;
		this.selected = selected;
		this.theme = theme;
		this.resolve = resolve;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold("Tools — space: toggle, enter: confirm, esc: cancel")));
		const total = this.names.length;
		this.visibleRows = Math.max(1, Math.min(total, 14));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.visibleRows) this.scrollTop = this.cursor + 1 - this.visibleRows;
		const visible = this.names.slice(this.scrollTop, this.scrollTop + this.visibleRows);
		const cursorOffset = this.cursor - this.scrollTop;
		for (let i = 0; i < visible.length; i++) {
			const name = visible[i];
			const box = this.selected.has(name) ? "x" : " ";
			const marker = i === cursorOffset ? ">" : " ";
			lines.push(`${this.theme.fg("muted", `${marker}[${box}]`)} ${name}`);
		}
		if (total > this.visibleRows) {
			lines.push(this.theme.fg("dim", `  ${this.scrollTop + 1}-${Math.min(this.scrollTop + this.visibleRows, total)} of ${total}`));
		}
		lines.push(this.theme.fg("muted", `${this.selected.size} selected`));
		return lines;
	}

	handleInput(data: string): void {
		const total = this.names.length;
		if (matchesKey(data, Key.up)) {
			this.cursor = (this.cursor - 1 + total) % total;
		} else if (matchesKey(data, Key.down)) {
			this.cursor = (this.cursor + 1) % total;
		} else if (matchesKey(data, Key.space)) {
			const name = this.names[this.cursor];
			if (this.selected.has(name)) this.selected.delete(name);
			else this.selected.add(name);
		} else if (matchesKey(data, Key.enter)) {
			this.resolve([...this.selected]);
		} else if (matchesKey(data, Key.escape)) {
			this.resolve(null);
		}
	}

	invalidate(): void {}
}

export default function launchPickerExtension(pi: ExtensionAPI) {
	let profiles: ProfilesFile = { profiles: {} };
	let prompts: Record<string, string> = {};
	let activeProfile: string | undefined;
	/** undefined = built-in prompt, "" = empty, otherwise a preset name. */
	let activePrompt: string | undefined;
	let initialTools: string[] | undefined;

	function loadProfiles(): ProfilesFile {
		try {
			if (existsSync(PROFILES_FILE)) {
				const parsed = JSON.parse(readFileSync(PROFILES_FILE, "utf-8")) as ProfilesFile;
				if (parsed && typeof parsed === "object" && parsed.profiles) return parsed;
			}
		} catch {
			// fall through to empty
		}
		return { profiles: {} };
	}

	function saveProfiles(): void {
		try {
			writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, "\t") + "\n");
		} catch (err) {
			console.error(`launch-picker: failed to save profiles: ${err}`);
		}
	}

	function loadPrompts(): Record<string, string> {
		const out: Record<string, string> = {};
		if (!existsSync(PROMPTS_DIR)) return out;
		for (const file of readdirSync(PROMPTS_DIR)) {
			if (!file.endsWith(".md")) continue;
			try {
				out[file.slice(0, -3)] = readFileSync(join(PROMPTS_DIR, file), "utf-8");
			} catch {
				// skip unreadable file
			}
		}
		return out;
	}

	function visibleTools(): string[] {
		return pi.getAllTools().filter((t) => t.exposure !== "hidden").map((t) => t.name);
	}

	function promptChoices(): string[] {
		return [DEFAULT_PROMPT, EMPTY_PROMPT, ...Object.keys(prompts).sort()];
	}

	function updateStatus(ctx: ExtensionContext): void {
		const parts: string[] = [];
		if (activeProfile) parts.push(`profile:${activeProfile}`);
		if (activePrompt === "") parts.push("prompt:(empty)");
		else if (activePrompt) parts.push(`prompt:${activePrompt}`);
		if (parts.length > 0) ctx.ui.setStatus("launch-picker", ctx.ui.theme.fg("accent", parts.join(" ")));
		else ctx.ui.setStatus("launch-picker", undefined);
	}

	async function applyPrompt(name: string, ctx: ExtensionContext): Promise<boolean> {
		if (name === DEFAULT_PROMPT) {
			activePrompt = undefined;
		} else if (name === EMPTY_PROMPT) {
			activePrompt = "";
		} else if (prompts[name] !== undefined) {
			activePrompt = name;
		} else {
			ctx.ui.notify(`Unknown prompt preset "${name}". Available: ${promptChoices().join(", ")}`, "error");
			return false;
		}
		updateStatus(ctx);
		return true;
	}

	async function applyProfile(name: string, ctx: ExtensionContext): Promise<boolean> {
		const profile = profiles.profiles[name];
		if (!profile) {
			const available = Object.keys(profiles.profiles).join(", ") || "(none defined)";
			ctx.ui.notify(`Unknown profile "${name}". Available: ${available}`, "error");
			return false;
		}
		const known = new Set(visibleTools());
		if (profile.tools !== undefined) {
			const valid = profile.tools.filter((n) => known.has(n));
			const unknown = profile.tools.filter((n) => !known.has(n));
			if (unknown.length > 0) {
				ctx.ui.notify(`Profile "${name}": unknown tools: ${unknown.join(", ")}`, "warning");
			}
			pi.setActiveTools(valid);
		}
		if (profile.prompt !== undefined) {
			await applyPrompt(profile.prompt, ctx);
		}
		activeProfile = name;
		profiles.last = name;
		saveProfiles();
		updateStatus(ctx);
		return true;
	}

	async function clearAll(ctx: ExtensionContext): Promise<void> {
		activeProfile = undefined;
		activePrompt = undefined;
		if (initialTools) pi.setActiveTools(initialTools);
		profiles.last = undefined;
		saveProfiles();
		updateStatus(ctx);
	}

	async function runCustomFlow(ctx: ExtensionContext): Promise<void> {
		const tools = await ctx.ui.custom<string[] | null>((_tui, theme, _kb, done) =>
			new ToolMultiSelect(visibleTools(), new Set(pi.getActiveTools()), theme, (result) => done(result)),
		);
		if (tools === null) {
			ctx.ui.notify("Custom profile cancelled", "info");
			return;
		}
		const promptChoice = await ctx.ui.select("System prompt preset", promptChoices());
		if (!promptChoice) return;
		const rawName = await ctx.ui.input("Profile name", "e.g. research");
		if (!rawName || !rawName.trim()) return;
		const name = rawName.trim();
		profiles = loadProfiles();
		profiles.profiles[name] = { tools, prompt: promptChoice };
		profiles.last = name;
		saveProfiles();
		await applyProfile(name, ctx);
		ctx.ui.notify(`Profile "${name}" saved and applied`, "info");
	}

	async function runPicker(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		profiles = loadProfiles();
		prompts = loadPrompts();
		const options = [
			...Object.keys(profiles.profiles).sort(),
			NONE_CHOICE,
			...(ctx.mode === "tui" ? [CUSTOM_CHOICE] : []),
		];
		const choice = await ctx.ui.select("Launch profile", options);
		if (!choice) return;
		if (choice === NONE_CHOICE) {
			await clearAll(ctx);
			ctx.ui.notify("Launch configuration cleared: default prompt and tools", "info");
			return;
		}
		if (choice === CUSTOM_CHOICE) {
			await runCustomFlow(ctx);
			return;
		}
		if (await applyProfile(choice, ctx)) {
			ctx.ui.notify(`Profile "${choice}" applied`, "info");
		}
	}

	// Replace the whole system prompt for each turn while a preset is active.
	pi.on("before_agent_start", async () => {
		if (activePrompt === undefined) return;
		const text = activePrompt === "" ? "" : (prompts[activePrompt] ?? "");
		return { systemPrompt: text };
	});

	pi.on("session_start", async (event, ctx) => {
		profiles = loadProfiles();
		prompts = loadPrompts();
		if (event.reason === "startup") initialTools = pi.getActiveTools();

		const flag = pi.getFlag("lp-profile");
		const entries = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "launch-state") as Array<{
			data?: { profile?: string };
		}>;
		const entryProfile = entries.pop()?.data?.profile;

		if (typeof flag === "string" && flag) {
			if (profiles.profiles[flag]) {
				await applyProfile(flag, ctx);
				ctx.ui.notify(`Profile "${flag}" applied (--lp-profile)`, "info");
			} else {
				ctx.ui.notify(`--lp-profile: unknown profile "${flag}"`, "error");
			}
		} else if (entryProfile && profiles.profiles[entryProfile]) {
			await applyProfile(entryProfile, ctx);
		} else if (profiles.last && profiles.profiles[profiles.last]) {
			await applyProfile(profiles.last, ctx);
		} else if (event.reason === "startup" && ctx.mode === "tui") {
			await runPicker(ctx);
		}
		updateStatus(ctx);
	});

	pi.on("turn_start", async () => {
		if (activeProfile) {
			pi.appendEntry("launch-state", { profile: activeProfile });
		}
	});

	pi.registerFlag("lp-profile", {
		description: "Launch profile to apply at startup",
		type: "string",
	});

	pi.registerShortcut(Key.ctrlShift("l"), {
		description: "Open launch picker",
		handler: async (ctx) => {
			await runPicker(ctx);
		},
	});

	pi.registerCommand("lpick", {
		description: "Open the launch picker (profile, tools, system prompt)",
		handler: async (_args, ctx) => {
			await runPicker(ctx);
		},
	});

	pi.registerCommand("lprofile", {
		description: "Apply a launch profile: /lprofile <name>; no argument opens the picker; (none) clears",
		handler: async (args, ctx) => {
			profiles = loadProfiles();
			prompts = loadPrompts();
			const name = args?.trim();
			if (!name) {
				await runPicker(ctx);
				return;
			}
			if (name === NONE_CHOICE) {
				await clearAll(ctx);
				ctx.ui.notify("Launch configuration cleared", "info");
			} else {
				await applyProfile(name, ctx);
			}
		},
	});

	pi.registerCommand("lprompt", {
		description: `Set the system prompt preset: /lprompt <name> ("${DEFAULT_PROMPT}", "${EMPTY_PROMPT}", or a preset); no argument opens a selector`,
		handler: async (args, ctx) => {
			prompts = loadPrompts();
			const name = args?.trim();
			if (!name) {
				const choice = await ctx.ui.select("System prompt preset", promptChoices());
				if (choice) await applyPrompt(choice, ctx);
				return;
			}
			await applyPrompt(name, ctx);
		},
	});

	pi.registerCommand("ltools", {
		description: 'Set active tools: /ltools all | none | <tool1,tool2,...>',
		handler: async (args, ctx) => {
			const spec = args?.trim();
			if (!spec) {
				ctx.ui.notify('Usage: /ltools all | none | read,bash,edit', "warning");
				return;
			}
			const all = visibleTools();
			if (spec === "all") {
				pi.setActiveTools(all);
			} else if (spec === "none") {
				pi.setActiveTools([]);
			} else {
				const wanted = spec
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const known = new Set(all);
				const valid = wanted.filter((n) => known.has(n));
				const unknown = wanted.filter((n) => !known.has(n));
				if (unknown.length > 0) {
					ctx.ui.notify(`Unknown tools: ${unknown.join(", ")}`, "warning");
				}
				pi.setActiveTools(valid);
			}
			activeProfile = undefined;
			updateStatus(ctx);
			ctx.ui.notify(`Active tools: ${pi.getActiveTools().join(", ") || "(none)"}`, "info");
		},
	});

	function effectivePrompt(ctx: ExtensionContext): string {
		if (activePrompt === undefined) return ctx.getSystemPrompt();
		if (activePrompt === "") return "";
		return prompts[activePrompt] ?? "";
	}

	function skillNamesAndExclusion(commands: ReturnType<typeof pi.getCommands>): { loaded: string[]; excluded: Set<string> } {
		const skillCommands = commands.filter((c) => c.source === "skill");
		const loaded = [...new Set(skillCommands.map((c) => c.name.replace(/^skill:/, "")))].sort();
		const excluded = new Set<string>();
		for (const cmd of skillCommands) {
			try {
				const text = readFileSync(cmd.sourceInfo.path, "utf-8");
				const end = text.indexOf("\n---", 3);
				const frontmatter = text.startsWith("---") && end > 0 ? text.slice(3, end) : "";
				if (/^\s*disable-model-invocation:\s*true\s*$/m.test(frontmatter)) {
					excluded.add(cmd.name.replace(/^skill:/, ""));
				}
			} catch {
				// unreadable skill file: treat as in-prompt
			}
		}
		return { loaded, excluded };
	}

	function stateSummary(ctx: ExtensionContext): string {
		const active = pi.getActiveTools();
		const total = pi.getAllTools().filter((t) => t.exposure !== "hidden").length;
		const toolList =
			active.length > 15 ? `${active.slice(0, 15).join(", ")} (+${active.length - 15} more)` : active.join(", ") || "(none)";

		const commands = pi.getCommands();
		const { loaded: skills, excluded } = skillNamesAndExclusion(commands);
		const exts = [...
			new Set(
				commands
					.filter((c) => c.source === "extension")
					.map((c) => {
						const { path, source } = c.sourceInfo;
						if (path.startsWith("builtin:")) return path;
						if (source.startsWith("npm:") || source.startsWith("git:")) return source;
						return (path.split("/").pop() ?? source).replace(/\.(ts|js)$/i, "");
					}),
			),
		].sort();

		const promptName = activePrompt === undefined ? "(default)" : activePrompt === "" ? "(empty)" : activePrompt;
		const promptLen = effectivePrompt(ctx).length;
		const inPrompt = skills.filter((n) => !excluded.has(n));
		// pi injects the skills block only when read or bash is active (the model needs a way to open SKILL.md).
		const skillReader = ["read", "bash"].find((tool) => active.includes(tool));
		const skillsSent = skillReader !== undefined;
		const skillLine =
			skills.length === 0
				? "skills: (none)"
				: `skills: ${skillsSent ? inPrompt.length : 0}/${skills.length} in prompt — ${skills.join(", ")}${
						skillsSent ? "" : ` (not sent: no read/bash tool active)`
					}${
						skillsSent && excluded.size > 0 ? ` (hidden from prompt: ${[...excluded].sort().join(", ")})` : ""
					}`;
		return [
			"Session state",
			`tools: ${active.length}/${total} — ${toolList}`,
			`prompt: ${promptName} — ${promptLen} chars`,
			skillLine,
			exts.length ? `extensions: ${exts.length} loaded — ${exts.join(", ")}` : "extensions: (none)",
			`profile: ${activeProfile ?? "(none)"}  last: ${profiles.last ?? "(none)"}`,
		].join("\n");
	}

	pi.registerCommand("lstate", {
		description: "Show session state: tools, skills, extensions, system prompt (argument 'prompt' dumps the full prompt)",
		handler: async (args, ctx) => {
			profiles = loadProfiles();
			prompts = loadPrompts();
			if (args?.trim() === "prompt") {
				const sys = effectivePrompt(ctx);
				const cap = 4000;
				ctx.ui.notify(`System prompt (${sys.length} chars):\n${sys.length > cap ? `${sys.slice(0, cap)} …[truncated]` : sys}`, "info");
			} else {
				ctx.ui.notify(stateSummary(ctx), "info");
			}
		},
	});

	pi.registerCommand("lsave", {
		description: "Save the current tools + system prompt as a named profile",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				ctx.ui.notify("Usage: /lsave <name>", "warning");
				return;
			}
			profiles = loadProfiles();
			const prompt = activePrompt === undefined ? DEFAULT_PROMPT : activePrompt === "" ? EMPTY_PROMPT : activePrompt;
			profiles.profiles[name] = { tools: pi.getActiveTools(), prompt };
			profiles.last = name;
			activeProfile = name;
			saveProfiles();
			updateStatus(ctx);
			ctx.ui.notify(`Profile "${name}" saved`, "info");
		},
	});
}
