/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, GCBasedDisposableTracker, MutableDisposable, setDisposableTracker, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Extensions, IWorkbenchContributionsRegistry, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorSerializer, IEditorFactoryRegistry } from '../../../common/editor.js';
import { PerfviewContrib, PerfviewInput } from './perfviewEditor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { InstantiationService, Trace } from '../../../../platform/instantiation/common/instantiationService.js';
import { EventProfiling } from '../../../../base/common/event.js';
import { InputLatencyContrib } from './inputLatencyContrib.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IProcessService, IResolvedProcessInformation } from '../../../../platform/process/common/process.js';
import { isRemoteDiagnosticError } from '../../../../platform/diagnostics/common/diagnostics.js';
import './media/performanceProfileView.css';

// -- startup performance view

registerWorkbenchContribution2(
	PerfviewContrib.ID,
	PerfviewContrib,
	{ lazy: true }
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PerfviewInput.Id,
	class implements IEditorSerializer {
		canSerialize(): boolean {
			return true;
		}
		serialize(): string {
			return '';
		}
		deserialize(instantiationService: IInstantiationService): PerfviewInput {
			return instantiationService.createInstance(PerfviewInput);
		}
	}
);


registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'perfview.show',
			title: localize2('show.label', 'Startup Performance'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const editorService = accessor.get(IEditorService);
		const contrib = PerfviewContrib.get();
		return editorService.openEditor(contrib.getEditorInput(), { pinned: true });
	}
});


registerAction2(class PrintServiceCycles extends Action2 {

	constructor() {
		super({
			id: 'perf.insta.printAsyncCycles',
			title: localize2('cycles', 'Print Service Cycles'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const instaService = accessor.get(IInstantiationService);
		if (instaService instanceof InstantiationService) {
			const cycle = instaService._globalGraph?.findCycleSlow();
			if (cycle) {
				console.warn(`CYCLE`, cycle);
			} else {
				console.warn(`YEAH, no more cycles`);
			}
		}
	}
});

registerAction2(class PrintServiceTraces extends Action2 {

	constructor() {
		super({
			id: 'perf.insta.printTraces',
			title: localize2('insta.trace', 'Print Service Traces'),
			category: Categories.Developer,
			f1: true
		});
	}

	run() {
		if (Trace.all.size === 0) {
			console.log('Enable via `instantiationService.ts#_enableAllTracing`');
			return;
		}

		for (const item of Trace.all) {
			console.log(item);
		}
	}
});


registerAction2(class PrintEventProfiling extends Action2 {

	constructor() {
		super({
			id: 'perf.event.profiling',
			title: localize2('emitter', 'Print Emitter Profiles'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(): void {
		if (EventProfiling.all.size === 0) {
			console.log('USE `EmitterOptions._profName` to enable profiling');
			return;
		}
		for (const item of EventProfiling.all) {
			console.log(`${item.name}: ${item.invocationCount} invocations COST ${item.elapsedOverall}ms, ${item.listenerCount} listeners, avg cost is ${item.durations.reduce((a, b) => a + b, 0) / item.durations.length}ms`);
		}
	}
});

// -- input latency

Registry.as<IWorkbenchContributionsRegistry>(Extensions.Workbench).registerWorkbenchContribution(
	InputLatencyContrib,
	LifecyclePhase.Eventually
);


// -- track leaking disposables, those that get GC'ed before having been disposed


class DisposableTracking {
	static readonly Id = 'perf.disposableTracking';
	constructor(@IEnvironmentService envService: IEnvironmentService) {
		if (!envService.isBuilt && !envService.extensionTestsLocationURI) {
			setDisposableTracker(new GCBasedDisposableTracker());
		}
	}
}

registerWorkbenchContribution2(DisposableTracking.Id, DisposableTracking, WorkbenchPhase.Eventually);

const OPENDEV_PERFORMANCE_PROFILE_SETTING = 'opendev.performance.profile';
const OPENDEV_PERFORMANCE_PROFILE_COMMAND_ID = 'workbench.action.opendev.selectPerformanceProfile';
const OPENDEV_PERFORMANCE_VIEW_CONTAINER_ID = 'workbench.view.opendevPerformance';
const OPENDEV_PERFORMANCE_VIEW_ID = 'workbench.views.opendevPerformance.profile';

const enum OpenDevPerformanceProfile {
	Balanced = 'balanced',
	LowMemory = 'low-memory'
}

const LOW_MEMORY_MODE_SETTINGS: ReadonlyArray<readonly [string, boolean]> = [
	['workbench.list.smoothScrolling', false],
	['editor.smoothScrolling', false],
	['editor.minimap.enabled', false],
	['breadcrumbs.enabled', false]
];

const LOW_MEMORY_WATCHER_EXCLUDE: Readonly<Record<string, boolean>> = {
	'**/node_modules/**': true,
	'**/dist/**': true,
	'**/build/**': true,
	'**/out/**': true,
	'**/.next/**': true,
	'**/target/**': true
};

const openDevPerformanceViewIcon = registerIcon(
	'opendev-performance-view-icon',
	Codicon.dashboard,
	localize('openDevPerformanceViewIcon', 'View icon of the performance profile view.')
);

class OpenDevPerformanceProfileView extends ViewPane {
	static readonly ID = OPENDEV_PERFORMANCE_VIEW_ID;
	private static readonly HISTORY_POINTS = 24;

	private readonly processService: IProcessService | undefined;
	private profileBadgeElement: HTMLSpanElement | undefined;
	private cpuValueElement: HTMLSpanElement | undefined;
	private ramValueElement: HTMLSpanElement | undefined;
	private loadValueElement: HTMLSpanElement | undefined;
	private systemMemoryValueElement: HTMLSpanElement | undefined;
	private statusElement: HTMLDivElement | undefined;
	private lastUpdatedElement: HTMLSpanElement | undefined;
	private cpuBarFillElement: HTMLDivElement | undefined;
	private ramBarFillElement: HTMLDivElement | undefined;
	private cpuHistoryBarsElement: HTMLDivElement | undefined;
	private ramHistoryBarsElement: HTMLDivElement | undefined;
	private cpuHistory: number[] = [];
	private ramHistory: number[] = [];

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		try {
			this.processService = instantiationService.invokeFunction(accessor => accessor.get(IProcessService));
		} catch {
			this.processService = undefined;
		}
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = document.createElement('div');
		root.className = 'opendev-performance-view';
		container.appendChild(root);

		const header = document.createElement('section');
		header.className = 'odv-header';
		root.appendChild(header);

		const titleWrap = document.createElement('div');
		titleWrap.className = 'odv-header-title-wrap';
		header.appendChild(titleWrap);

		const title = document.createElement('h2');
		title.className = 'odv-title';
		title.textContent = localize('openDevPerformanceProfileView.title', "Performance Dashboard");
		titleWrap.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.className = 'odv-subtitle';
		subtitle.textContent = localize('openDevPerformanceProfileView.subtitle', "Live resource metrics and profile mode");
		titleWrap.appendChild(subtitle);

		const meta = document.createElement('div');
		meta.className = 'odv-header-meta';
		header.appendChild(meta);

		this.profileBadgeElement = document.createElement('span');
		this.profileBadgeElement.className = 'odv-profile-badge';
		meta.appendChild(this.profileBadgeElement);

		this.lastUpdatedElement = document.createElement('span');
		this.lastUpdatedElement.className = 'odv-last-updated';
		meta.appendChild(this.lastUpdatedElement);

		const metricsGrid = document.createElement('section');
		metricsGrid.className = 'odv-metrics-grid';
		root.appendChild(metricsGrid);

		const cpuCard = this.createMetricCard(
			localize('openDevPerformanceProfileView.cpuTitle', "CPU"),
			localize('openDevPerformanceProfileView.cpuSubtitle', "Process usage"),
			'odv-meter-fill--cpu'
		);
		this.cpuValueElement = cpuCard.value;
		this.cpuBarFillElement = cpuCard.barFill;
		metricsGrid.appendChild(cpuCard.card);

		const ramCard = this.createMetricCard(
			localize('openDevPerformanceProfileView.ramTitle', "RAM"),
			localize('openDevPerformanceProfileView.ramSubtitle', "Process memory"),
			'odv-meter-fill--ram'
		);
		this.ramValueElement = ramCard.value;
		this.ramBarFillElement = ramCard.barFill;
		metricsGrid.appendChild(ramCard.card);

		const loadCard = this.createStatCard(
			localize('openDevPerformanceProfileView.loadTitle', "Load"),
			localize('openDevPerformanceProfileView.loadSubtitle', "System average")
		);
		this.loadValueElement = loadCard.value;
		metricsGrid.appendChild(loadCard.card);

		const systemMemoryCard = this.createStatCard(
			localize('openDevPerformanceProfileView.systemMemoryTitle', "System Memory"),
			localize('openDevPerformanceProfileView.systemMemorySubtitle', "Total and free")
		);
		this.systemMemoryValueElement = systemMemoryCard.value;
		metricsGrid.appendChild(systemMemoryCard.card);

		const historyGrid = document.createElement('section');
		historyGrid.className = 'odv-history-grid';
		root.appendChild(historyGrid);

		const cpuHistoryCard = this.createHistoryCard(localize('openDevPerformanceProfileView.cpuHistory', "CPU Trend"), 'odv-history-bars--cpu');
		this.cpuHistoryBarsElement = cpuHistoryCard.bars;
		historyGrid.appendChild(cpuHistoryCard.card);

		const ramHistoryCard = this.createHistoryCard(localize('openDevPerformanceProfileView.ramHistory', "RAM Trend"), 'odv-history-bars--ram');
		this.ramHistoryBarsElement = ramHistoryCard.bars;
		historyGrid.appendChild(ramHistoryCard.card);

		this.statusElement = document.createElement('div');
		this.statusElement.className = 'odv-status';
		root.appendChild(this.statusElement);

		this.refreshMetrics().catch(onUnexpectedError);

		const targetWindow = container.ownerDocument.defaultView;
		if (!targetWindow) {
			return;
		}

		const intervalHandle = targetWindow.setInterval(() => {
			this.refreshMetrics().catch(onUnexpectedError);
		}, 5000);

		this._register(toDisposable(() => targetWindow.clearInterval(intervalHandle)));
	}

	private async refreshMetrics(): Promise<void> {
		if (!this.profileBadgeElement || !this.cpuValueElement || !this.ramValueElement || !this.loadValueElement || !this.systemMemoryValueElement || !this.statusElement || !this.lastUpdatedElement || !this.cpuBarFillElement || !this.ramBarFillElement || !this.cpuHistoryBarsElement || !this.ramHistoryBarsElement) {
			return;
		}

		const profile = getPerformanceProfile(this.configurationService);
		const profileLabel = profile === OpenDevPerformanceProfile.LowMemory
			? localize('profile.lowMemory', "Low Memory")
			: localize('profile.balanced', "Balanced");
		this.profileBadgeElement.textContent = localize('openDevPerformanceProfileView.profileBadge', "Profile: {0}", profileLabel);
		this.profileBadgeElement.classList.toggle('odv-profile-badge--low', profile === OpenDevPerformanceProfile.LowMemory);
		this.profileBadgeElement.classList.toggle('odv-profile-badge--balanced', profile !== OpenDevPerformanceProfile.LowMemory);

		if (!this.processService) {
			this.cpuValueElement.textContent = localize('openDevPerformanceProfileView.na', "N/A");
			this.ramValueElement.textContent = localize('openDevPerformanceProfileView.na', "N/A");
			this.loadValueElement.textContent = localize('openDevPerformanceProfileView.na', "N/A");
			this.systemMemoryValueElement.textContent = localize('openDevPerformanceProfileView.na', "N/A");
			this.setBarFill(this.cpuBarFillElement, 0);
			this.setBarFill(this.ramBarFillElement, 0);
			this.statusElement.textContent = localize('openDevPerformanceProfileView.unavailable', "Live CPU/RAM metrics are available in desktop builds.");
			this.lastUpdatedElement.textContent = localize('openDevPerformanceProfileView.lastUpdated', "Updated: {0}", new Date().toLocaleTimeString());
			return;
		}

		const [systemInfo, processInfo] = await Promise.all([
			this.processService.getSystemInfo(),
			this.processService.resolveProcesses()
		]);

		const totalSystemMemoryMB = this.parseSystemMemoryInMB(systemInfo.memory);
		const processMetrics = this.extractProcessMetrics(processInfo, totalSystemMemoryMB);
		const cpuUsage = this.asPercent(processMetrics.cpuPercent);
		const ramPercent = this.asPercent(processMetrics.memoryPercent);
		const ramUsageMB = processMetrics.memoryMB;

		this.cpuValueElement.textContent = typeof cpuUsage === 'number'
			? localize('openDevPerformanceProfileView.cpuValue', "{0}%", cpuUsage.toFixed(1))
			: localize('openDevPerformanceProfileView.na', "N/A");
		this.ramValueElement.textContent = typeof ramUsageMB === 'number'
			? localize('openDevPerformanceProfileView.ramValue', "{0} MB", ramUsageMB.toFixed(0))
			: localize('openDevPerformanceProfileView.na', "N/A");
		this.loadValueElement.textContent = systemInfo.load ?? localize('openDevPerformanceProfileView.na', "N/A");
		this.systemMemoryValueElement.textContent = systemInfo.memory;

		this.setBarFill(this.cpuBarFillElement, cpuUsage ?? 0);
		this.setBarFill(this.ramBarFillElement, ramPercent ?? 0);

		this.pushHistory(this.cpuHistory, cpuUsage);
		this.pushHistory(this.ramHistory, ramPercent);
		this.updateHistoryBars(this.cpuHistoryBarsElement, this.cpuHistory);
		this.updateHistoryBars(this.ramHistoryBarsElement, this.ramHistory);

		this.statusElement.textContent = profile === OpenDevPerformanceProfile.LowMemory
			? localize('openDevPerformanceProfileView.statusLow', "Low Memory mode is active: reduced watchers and lighter UI defaults are applied.")
			: localize('openDevPerformanceProfileView.statusBalanced', "Balanced mode is active: full defaults are enabled.");
		this.lastUpdatedElement.textContent = localize('openDevPerformanceProfileView.lastUpdated', "Updated: {0}", new Date().toLocaleTimeString());
	}

	private extractProcessMetrics(processInfo: IResolvedProcessInformation, totalSystemMemoryMB: number | undefined): { cpuPercent?: number; memoryMB?: number; memoryPercent?: number } {
		const localProcessRoot = processInfo.processes.find(process => !isRemoteDiagnosticError(process.rootProcess))?.rootProcess;
		if (!localProcessRoot || isRemoteDiagnosticError(localProcessRoot)) {
			return {};
		}

		const cpuPercent = this.asPercent(localProcessRoot.load);
		const memory = this.normalizeMemory(localProcessRoot.mem, totalSystemMemoryMB);

		return {
			cpuPercent,
			memoryMB: memory.memoryMB,
			memoryPercent: memory.memoryPercent
		};
	}

	private normalizeMemory(memoryValue: number, totalSystemMemoryMB: number | undefined): { memoryMB?: number; memoryPercent?: number } {
		if (!Number.isFinite(memoryValue) || memoryValue < 0) {
			return {};
		}

		if (memoryValue <= 100 && totalSystemMemoryMB) {
			return {
				memoryMB: totalSystemMemoryMB * (memoryValue / 100),
				memoryPercent: this.asPercent(memoryValue)
			};
		}

		if (memoryValue > 1024 * 1024) {
			const memoryMB = memoryValue / (1024 * 1024);
			return {
				memoryMB,
				memoryPercent: totalSystemMemoryMB ? this.asPercent((memoryMB / totalSystemMemoryMB) * 100) : undefined
			};
		}

		return {
			memoryMB: memoryValue,
			memoryPercent: totalSystemMemoryMB ? this.asPercent((memoryValue / totalSystemMemoryMB) * 100) : undefined
		};
	}

	private parseSystemMemoryInMB(memoryInfo: string): number | undefined {
		const totalGbMatch = /^\s*([\d.]+)\s*GB/i.exec(memoryInfo);
		if (!totalGbMatch) {
			return undefined;
		}

		const totalGb = Number(totalGbMatch[1]);
		if (Number.isNaN(totalGb)) {
			return undefined;
		}

		return totalGb * 1024;
	}

	private asPercent(value: number | undefined): number | undefined {
		if (typeof value !== 'number' || Number.isNaN(value)) {
			return undefined;
		}

		return Math.max(0, Math.min(100, value));
	}

	private setBarFill(element: HTMLElement, percent: number): void {
		const width = Math.max(0, Math.min(100, percent));
		element.style.width = `${width}%`;
	}

	private pushHistory(history: number[], value: number | undefined): void {
		history.push(typeof value === 'number' ? value : 0);
		if (history.length > OpenDevPerformanceProfileView.HISTORY_POINTS) {
			history.splice(0, history.length - OpenDevPerformanceProfileView.HISTORY_POINTS);
		}
	}

	private updateHistoryBars(container: HTMLElement, history: readonly number[]): void {
		container.replaceChildren();

		for (const value of history) {
			const bar = document.createElement('span');
			bar.className = 'odv-history-bar';
			bar.style.height = `${Math.max(5, value)}%`;
			container.appendChild(bar);
		}
	}

	private createMetricCard(title: string, subtitle: string, fillModifierClass: string): { card: HTMLDivElement; value: HTMLSpanElement; barFill: HTMLDivElement } {
		const card = document.createElement('article');
		card.className = 'odv-card';

		const labelElement = document.createElement('span');
		labelElement.className = 'odv-card-label';
		labelElement.textContent = title;
		card.appendChild(labelElement);

		const value = document.createElement('span');
		value.className = 'odv-card-value';
		value.textContent = localize('openDevPerformanceProfileView.loading', 'Loading...');
		card.appendChild(value);

		const subtitleElement = document.createElement('span');
		subtitleElement.className = 'odv-card-subtitle';
		subtitleElement.textContent = subtitle;
		card.appendChild(subtitleElement);

		const meter = document.createElement('div');
		meter.className = 'odv-meter';
		card.appendChild(meter);

		const barFill = document.createElement('div');
		barFill.className = `odv-meter-fill ${fillModifierClass}`;
		meter.appendChild(barFill);

		return { card, value, barFill };
	}

	private createStatCard(title: string, subtitle: string): { card: HTMLDivElement; value: HTMLSpanElement } {
		const card = document.createElement('article');
		card.className = 'odv-card';

		const labelElement = document.createElement('span');
		labelElement.className = 'odv-card-label';
		labelElement.textContent = title;
		card.appendChild(labelElement);

		const value = document.createElement('span');
		value.className = 'odv-card-value';
		value.textContent = localize('openDevPerformanceProfileView.loading', 'Loading...');
		card.appendChild(value);

		const subtitleElement = document.createElement('span');
		subtitleElement.className = 'odv-card-subtitle';
		subtitleElement.textContent = subtitle;
		card.appendChild(subtitleElement);

		return { card, value };
	}

	private createHistoryCard(title: string, barsModifierClass: string): { card: HTMLDivElement; bars: HTMLDivElement } {
		const card = document.createElement('article');
		card.className = 'odv-card odv-card--history';

		const labelElement = document.createElement('span');
		labelElement.className = 'odv-card-label';
		labelElement.textContent = title;
		card.appendChild(labelElement);

		const bars = document.createElement('div');
		bars.className = `odv-history-bars ${barsModifierClass}`;
		card.appendChild(bars);

		return { card, bars };
	}
}

const openDevPerformanceViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: OPENDEV_PERFORMANCE_VIEW_CONTAINER_ID,
	title: localize2('openDevPerformanceViewContainer', 'Performance'),
	icon: openDevPerformanceViewIcon,
	order: 7,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OPENDEV_PERFORMANCE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	openCommandActionDescriptor: {
		id: OPENDEV_PERFORMANCE_VIEW_CONTAINER_ID,
		mnemonicTitle: localize({ key: 'miOpenDevPerformanceView', comment: ['&& denotes a mnemonic'] }, "&&Performance"),
		order: 7
	}
}, ViewContainerLocation.Sidebar);

const performanceViewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
performanceViewsRegistry.registerViews([{
	id: OpenDevPerformanceProfileView.ID,
	name: localize2('openDevPerformanceProfileView', 'Performance Profile'),
	containerIcon: openDevPerformanceViewIcon,
	canMoveView: true,
	canToggleVisibility: true,
	ctorDescriptor: new SyncDescriptor(OpenDevPerformanceProfileView),
	order: 1
}], openDevPerformanceViewContainer);

function getPerformanceProfile(configurationService: IConfigurationService): OpenDevPerformanceProfile {
	const profile = configurationService.getValue<string>(OPENDEV_PERFORMANCE_PROFILE_SETTING);
	return profile === OpenDevPerformanceProfile.LowMemory ? OpenDevPerformanceProfile.LowMemory : OpenDevPerformanceProfile.Balanced;
}

class OpenDevPerformanceProfileContribution extends Disposable {
	static readonly ID = 'workbench.contrib.opendevPerformanceProfile';

	private static readonly statusbarEntryId = 'status.opendev.performanceProfile';

	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService
	) {
		super();

		const profile = getPerformanceProfile(this.configurationService);
		this.updateStatusbarEntry(profile);
		this.applyProfile(profile).catch(onUnexpectedError);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OPENDEV_PERFORMANCE_PROFILE_SETTING)) {
				const profile = getPerformanceProfile(this.configurationService);
				this.updateStatusbarEntry(profile);
				this.applyProfile(profile).catch(onUnexpectedError);
			}
		}));
	}

	private async applyProfile(profile: OpenDevPerformanceProfile): Promise<void> {
		if (profile === OpenDevPerformanceProfile.LowMemory) {
			const watcherExclude = {
				...(this.configurationService.getValue<Record<string, boolean>>('files.watcherExclude') ?? {}),
				...LOW_MEMORY_WATCHER_EXCLUDE
			};

			await Promise.all([
				this.configurationService.updateValue('files.watcherExclude', watcherExclude, ConfigurationTarget.MEMORY),
				...LOW_MEMORY_MODE_SETTINGS.map(([key, value]) => this.configurationService.updateValue(key, value, ConfigurationTarget.MEMORY))
			]);

			return;
		}

		await Promise.all([
			this.configurationService.updateValue('files.watcherExclude', undefined, ConfigurationTarget.MEMORY),
			...LOW_MEMORY_MODE_SETTINGS.map(([key]) => this.configurationService.updateValue(key, undefined, ConfigurationTarget.MEMORY))
		]);
	}

	private updateStatusbarEntry(profile: OpenDevPerformanceProfile): void {
		const profileLabel = profile === OpenDevPerformanceProfile.LowMemory
			? localize('status.lowMemory', "Low Memory")
			: localize('status.balanced', "Balanced");

		const entry: IStatusbarEntry = {
			name: localize('status.performanceProfile', "Performance Profile"),
			text: localize('status.performanceProfile.text', "Performance: {0}", profileLabel),
			ariaLabel: localize('status.performanceProfile.ariaLabel', "Performance profile: {0}", profileLabel),
			tooltip: profile === OpenDevPerformanceProfile.LowMemory
				? localize('status.performanceProfile.tooltip.lowMemory', "Low-memory mode is active. Reduced file watching and lighter UI defaults are applied.")
				: localize('status.performanceProfile.tooltip.balanced', "Balanced mode is active. Select this item to switch profiles."),
			command: {
				id: OPENDEV_PERFORMANCE_PROFILE_COMMAND_ID,
				title: localize('status.performanceProfile.command', "Select Performance Profile")
			},
			showInAllWindows: true
		};

		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(
				entry,
				OpenDevPerformanceProfileContribution.statusbarEntryId,
				StatusbarAlignment.LEFT,
				35
			);
		}
	}
}

registerWorkbenchContribution2(OpenDevPerformanceProfileContribution.ID, OpenDevPerformanceProfileContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPENDEV_PERFORMANCE_PROFILE_COMMAND_ID,
			title: localize2('selectPerformanceProfile', "Select Performance Profile"),
			category: Categories.Preferences,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);

		const currentProfile = getPerformanceProfile(configurationService);

		const picks: (IQuickPickItem & { profile: OpenDevPerformanceProfile })[] = [
			{
				profile: OpenDevPerformanceProfile.Balanced,
				label: localize('performanceProfile.balanced.label', "Balanced"),
				description: localize('performanceProfile.balanced.description', "Standard defaults for modern hardware"),
				picked: currentProfile === OpenDevPerformanceProfile.Balanced
			},
			{
				profile: OpenDevPerformanceProfile.LowMemory,
				label: localize('performanceProfile.lowMemory.label', "Low Memory"),
				description: localize('performanceProfile.lowMemory.description', "Lower resource usage by reducing file watching and lighter UI defaults"),
				picked: currentProfile === OpenDevPerformanceProfile.LowMemory
			}
		];

		const pick = await quickInputService.pick(picks, {
			placeHolder: localize('performanceProfile.pick.placeholder', "Select a performance profile"),
			activeItem: picks.find(item => item.picked)
		});

		if (pick && pick.profile !== currentProfile) {
			await configurationService.updateValue(OPENDEV_PERFORMANCE_PROFILE_SETTING, pick.profile, ConfigurationTarget.USER);
		}
	}
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'opendev',
	title: localize('opendev.performance.configuration.title', "OpenDev"),
	type: 'object',
	properties: {
		[OPENDEV_PERFORMANCE_PROFILE_SETTING]: {
			type: 'string',
			enum: [OpenDevPerformanceProfile.Balanced, OpenDevPerformanceProfile.LowMemory],
			default: OpenDevPerformanceProfile.Balanced,
			markdownEnumDescriptions: [
				localize('opendev.performance.configuration.balanced', "Standard defaults for modern hardware."),
				localize('opendev.performance.configuration.lowMemory', "Optimized for older laptops by reducing file watchers and using lighter UI defaults.")
			],
			markdownDescription: localize('opendev.performance.configuration.description', "Controls the performance profile OpenDev applies."),
			scope: ConfigurationScope.APPLICATION
		}
	}
});
