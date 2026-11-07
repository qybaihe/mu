/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	/** The option the cursor starts on. Defaults to the first. */
	initialIndex?: number;
}

/** One option: its marker, then its text, wrapped so that a long option continues under its text, not its marker. */
class OptionLine implements Component {
	private readonly marker: string;
	private readonly text: string;

	constructor(marker: string, text: string) {
		this.marker = marker;
		this.text = text;
	}

	render(width: number): string[] {
		const indent = " ".repeat(1 + 2);
		return wrapTextWithAnsi(this.text, Math.max(1, width - indent.length - 1)).map(
			(line, i) => `${i === 0 ? ` ${this.marker}` : indent}${line}`,
		);
	}

	invalidate(): void {}
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		const initial = opts?.initialIndex;
		if (initial !== undefined && Number.isInteger(initial) && initial >= 0 && initial < options.length) {
			this.selectedIndex = initial;
		}
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			this.listContainer.addChild(
				isSelected
					? new OptionLine(theme.fg("accent", "→ "), theme.fg("accent", this.options[i]))
					: new OptionLine("  ", theme.fg("text", this.options[i])),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
