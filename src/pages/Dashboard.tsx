import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { useNavigate, useSearchParams } from "react-router";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  Copy,
  Eye,
  FileSpreadsheet,
  MoreHorizontal,
  RefreshCw,
  Diamond,
  Download,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  PencilRuler,
  Plus,
  Redo2,
  RotateCcw,
  Sparkles,
  Layers,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import {
  addWorkingDays,
  ensureWorkingDay,
  findDependencyCycle,
  isoDate,
  remainingMarginDays,
  resolveWorkingDay,
  workingDaysBetween,
  type PlanningDirection,
} from "@/lib/scheduling-engine";
import { applyPlanningModeMargins, applyReplanMargins, dependenciesForTasks, duplicateTaskAssignments, duplicateTaskGroup, DISTRIBUTION_OPTIONS, fieldModeReadOnly, formatPredecessorsForDisplay, hasAllocationSegments, marginAfterPctChange, normalizeDistribution, normalizeWorkHours, orderTasksForDisplay, planFinishDate, recalculateTasks, replanScopeIds, resolvePredecessorInput, settleMonitoringPlan, startConstraintFor, startEditRestriction, withCalculatedPlanningFields, type PlannerTask, type PlanMode, type ReplanScope } from "@/lib/planner-model";
import { allocationSegments, canAdjustTask, displayHours, editLastAdjustment, fixedDaysOnNonWorkingDays, fixedUntil, lastActiveAdjustment, planAdjustment, previewRemoval, removeAllAdjustments, removeLastAdjustment, type AdjustmentInput } from "@/lib/remaining-work";
import { availableHours } from "@/lib/resource-capacity";
import { leafMarginTotals, marginRowsFor } from "@/lib/margin-report";
import { leaveLabels, taskLeaveInfo } from "@/lib/task-leave";
import { buildOverloadIndex, overloadByTask, overloadTooltip, projectOverload, type OverloadWeek } from "@/lib/overload";
import { selectCapacityProjects, unavailableWarning } from "@/lib/capacity-engine";
import { optimizeProject, OCCUPANCY_TARGET, type OptimizationPlan } from "@/lib/resource-optimizer";
import { fixedMilestoneChoices, loadFixedMilestones, saveFixedMilestones } from "@/lib/optimize-milestones";
import { CALENDAR_TYPE_LABELS, useCalendarStore, type Baseline } from "@/lib/calendar-store";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AppBar } from "@/components/AppBar";
import { AdjustRemainingWorkDialog } from "@/components/AdjustRemainingWorkDialog";

type Task = PlannerTask;
type ColumnKey = "id" | "wbs" | "name" | "duration" | "work" | "distribution" | "start" | "finish" | "predecessors" | "resource" | "availability" | "percent" | "actualStart" | "actualFinish" | "notes" | "margin" | "marginOriginal" | "marginConsumed" | "marginRemaining" | "totalFloat" | "baselineStart" | "baselineFinish" | "variance";

/** The columns each mode puts the spotlight on. Planning is about the plan,
 *  monitoring is about what really happened versus the baseline. */
const modeEmphasis: Record<PlanMode, ColumnKey[]> = {
  planning: ["duration", "predecessors", "margin", "totalFloat"],
  monitoring: ["percent", "actualStart", "actualFinish", "marginConsumed", "marginRemaining", "variance"],
};

/** The finish move that used the reserve is reported here, so the consumption is
 *  visible whether you are looking at the finish date or at the margin columns. */
const absorptionColumns: ColumnKey[] = ["finish", "margin", "marginConsumed", "marginRemaining"];

const rowHeight = 42;
const todayLineDate = isoDate(new Date());
const columnDefs: { key: ColumnKey; label: string; width: number }[] = [
  { key: "id", label: "ID", width: 58 },
  { key: "wbs", label: "WBS", width: 70 },
  { key: "name", label: "Task name", width: 238 },
  { key: "duration", label: "Duration", width: 105 },
  { key: "work", label: "Work", width: 84 },
  { key: "distribution", label: "Distribution", width: 138 },
  { key: "start", label: "Start", width: 112 },
  { key: "finish", label: "Finish", width: 112 },
  { key: "predecessors", label: "Predecessors", width: 128 },
  { key: "totalFloat", label: "Float", width: 84 },
  { key: "resource", label: "Resource", width: 118 },
  { key: "availability", label: "Beschikbaarheid", width: 124 },
  { key: "percent", label: "% complete", width: 96 },
  { key: "actualStart", label: "Actual start", width: 110 },
  { key: "actualFinish", label: "Actual finish", width: 110 },
  { key: "notes", label: "Notes", width: 160 },
  { key: "margin", label: "Margin %", width: 92 },
  { key: "marginOriginal", label: "Margin original", width: 112 },
  { key: "marginConsumed", label: "Margin consumed", width: 118 },
  { key: "marginRemaining", label: "Margin remaining", width: 120 },
  { key: "baselineStart", label: "Baseline start", width: 112 },
  { key: "baselineFinish", label: "Baseline finish", width: 120 },
  { key: "variance", label: "Variance", width: 120 },
];

const parseDate = (date: string) => new Date(`${date}T12:00:00`);
/** Availability hours: at most one decimal, no trailing .0. */
const formatAvailableHours = (hours: number) => {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};
const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parseDate(date));
/** Baselines are dated in full: the capture date is how you tell two apart. */
const formatFullDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(parseDate(date));
const baselineDateOf = (baseline: Baseline) => baseline.captureDate || baseline.createdAt.slice(0, 10);

const parseDurationInput = (value: string, fallback: { amount: number; unit: "days" | "weeks" }) => {
  const match = value.trim().match(/^(\d+(?:[.,]\d+)?)\s*(d|day|days|w|week|weeks)?$/i);
  if (!match) return fallback;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return fallback;
  const unit = match[2]?.toLowerCase();
  return {
    amount,
    unit: unit === "w" || unit === "week" || unit === "weeks" ? "weeks" : "days",
  } as const;
};

const dateLabel = (date: Date) => isoDate(date);

const getWbs = (task: Task, tasks: Task[]) => {
  const parts: number[] = [];
  let current: Task | undefined = task;
  while (current) {
    const siblings = tasks.filter((candidate) => candidate.parentId === current?.parentId);
    parts.unshift(siblings.findIndex((candidate) => candidate.id === current?.id) + 1);
    current = current.parentId ? tasks.find((candidate) => candidate.id === current?.parentId) : undefined;
  }
  return parts.join(".");
};

/** The inline notice for a task whose finish moved and used its own reserve. */
const formatAbsorption = (change: { absorbed: number; passed: number; returned: number }) => {
  const parts: string[] = [];
  if (change.absorbed) parts.push(`${change.absorbed} d absorbed by margin`);
  if (change.passed) parts.push(`${change.passed} d passed on to successors`);
  if (change.returned) parts.push(`${change.returned} d returned to margin`);
  return `${parts.join(", ")}.`;
};

export default function Dashboard() {
  const navigate = useNavigate();
  // The shared app bar searches everywhere; a ?q= on the URL is how another
  // screen hands its query over to the planner.
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    system,      activeProject,
      tasks,
      setTasks,
    setProjectCalendar,
    previewProjectRelink,
    projects,
    activeProjectId,
    setActiveProject,
    projectTasks,
    resources,
    assignments,
    setTaskAssignments,
    deleteTasks,
    resourceLeave,
    planVersions,
    activeVersionId,
    setActiveVersion,
    setPlanMode,
    createPlanVersion,
    replanProject,
    createBaseline,
    deleteBaseline,
    baselines,
    baselineTasks,
    saveAsTemplate,
    focusTask,
    clearFocusTask,
    company,
  } = useCalendarStore();
  // The signed-in account, recorded on every adjustment log entry.
  const selfMember = company?.members.find((member) => member.isSelf);
  const adjustmentActor = { id: selfMember?.userId ?? "unknown", name: selfMember?.name || selfMember?.email || "You" };
  const calendarId = activeProject.calendarId;
  const calendarName = system.calendars.find((calendar) => calendar.id === calendarId)?.name ?? "Unlinked";
  // The mode belongs to the active version, not the project. A version with no
  // stored mode is a version being planned.
  const activePlanVersion = planVersions.find((version) => version.id === activeVersionId)
    ?? planVersions.find((version) => version.projectId === activeProjectId && version.isActive);
  const activeMode: PlanMode = activePlanVersion?.mode ?? "planning";
  const versionHasBaseline = baselines.some((baseline) => baseline.versionId === (activePlanVersion?.id ?? activeVersionId));
  useEffect(() => {
    setPlanningDirection(activeProject.schedulingDirection);
  }, [activeProjectId, activeProject.schedulingDirection]);

  const [selected, setSelected] = useState<string[]>(["3"]);
  // The resource overview can ask the planner to open one task in its project and
  // version; select that task, then clear the request so it fires exactly once.
  useEffect(() => {
    if (!focusTask) return;
    setSelected([focusTask.taskId]);
    clearFocusTask();
  }, [focusTask, clearFocusTask]);
  const [editing, setEditing] = useState<{ id: string; field: ColumnKey } | null>(null);
  const [resourceEditor, setResourceEditor] = useState<{ taskId: string; query: string } | null>(null);
  const [draft, setDraft] = useState("");
  // The id of a freshly inserted row that is still waiting for its name. Only while
  // it is set does the name field show "New task" as a placeholder instead of a value.
  const [namingTaskId, setNamingTaskId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"day" | "week" | "month" | "quarter">("week");
  const [split, setSplit] = useState(58);
  const [showMenu, setShowMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [modalTask, setModalTask] = useState<Task | null>(null);
  // The task whose remaining work is being re-planned, and the inline undo confirm.
  const [adjustTaskId, setAdjustTaskId] = useState<string | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  // Re-opening the most recent adjustment instead of adding a new one.
  const [adjustEdit, setAdjustEdit] = useState<AdjustmentInput | null>(null);
  // The pending removal, with the preview shown before it is confirmed.
  const [removalPrompt, setRemovalPrompt] = useState<{ taskId: string; mode: "last" | "all" } | null>(null);
  const [cellError, setCellError] = useState<{ taskId: string; column: ColumnKey; message: string } | null>(null);
  const [marginNotice, setMarginNotice] = useState<{ taskId: string; message: string } | null>(null);
  // Reported under the Finish cell: how a task's finish move used its reserve.
  const [absorptionNotice, setAbsorptionNotice] = useState<{ taskId: string; message: string } | null>(null);
  const [history, setHistory] = useState<Task[][]>([]);
  const [future, setFuture] = useState<Task[][]>([]);
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [projectSearch, setProjectSearch] = useState(() => searchParams.get("q") ?? "");
  const [projectHighlight, setProjectHighlight] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("vintage-gantt-project-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const [expandedGroups, setExpandedGroups] = useState<{ active: boolean; archived: boolean }>({ active: true, archived: false });
  const [hidden, setHidden] = useState<ColumnKey[]>(() => {
    const fallback: ColumnKey[] = ["actualStart", "actualFinish", "margin", "marginOriginal", "marginConsumed", "marginRemaining", "baselineStart", "baselineFinish", "variance"];
    try {
      // Float is visible by default, so legacy preferences (which always hid it)
      // are migrated once; from the next save on, the current key wins.
      const current = localStorage.getItem("vintage-gantt-hidden-columns-v2");
      const legacy = localStorage.getItem("vintage-gantt-hidden-columns");
      const saved = JSON.parse(current ?? legacy ?? "null");
      if (!Array.isArray(saved)) return fallback;
      const known = saved.filter((key): key is ColumnKey => columnDefs.some((column) => column.key === key));
      return current ? known : known.filter((key) => key !== "totalFloat");
    } catch { return fallback; }
  });
  const [sort, setSort] = useState<{ key: ColumnKey; direction: "asc" | "desc" } | null>(null);
  const toggleFloatSort = () => setSort((current) => {
    if (current?.key !== "totalFloat") return { key: "totalFloat" as ColumnKey, direction: "asc" as const };
    if (current.direction === "asc") return { key: "totalFloat" as ColumnKey, direction: "desc" as const };
    return null;
  });
  // Work sorts like Float: click once for ascending total hours, again for
  // descending, a third time to clear. Summaries sort on their rolled-up total.
  const toggleWorkSort = () => setSort((current) => {
    if (current?.key !== "work") return { key: "work" as ColumnKey, direction: "asc" as const };
    if (current.direction === "asc") return { key: "work" as ColumnKey, direction: "desc" as const };
    return null;
  });
  const [viewOpen, setViewOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // The context bar owns its menus; each closes the others so only one popover
  // is open at a time. (Zone 1 is the shared <AppBar/>.)
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [baselineManageOpen, setBaselineManageOpen] = useState(false);
  // Margin occupies real time, so its zone is drawn on the timeline by default.
  const [showMarginsOnBars, setShowMarginsOnBars] = useState(() => { try { return localStorage.getItem("vintage-gantt-show-margins") !== "false"; } catch { return true; } });
  const [showBaselineBars, setShowBaselineBars] = useState(() => { try { return localStorage.getItem("vintage-gantt-show-baselines") !== "false"; } catch { return true; } });
  // Leave is visible on bars by default (it only informs); the availability
  // column is an optional extra, off until switched on in View.
  const [showLeave, setShowLeave] = useState(() => { try { return localStorage.getItem("vintage-gantt-show-leave") !== "false"; } catch { return true; } });
  const [showAvailability, setShowAvailability] = useState(() => { try { return localStorage.getItem("vintage-gantt-show-availability") === "true"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("vintage-gantt-hidden-columns-v2", JSON.stringify(hidden)); localStorage.setItem("vintage-gantt-show-margins", String(showMarginsOnBars)); localStorage.setItem("vintage-gantt-show-baselines", String(showBaselineBars)); localStorage.setItem("vintage-gantt-show-leave", String(showLeave)); localStorage.setItem("vintage-gantt-show-availability", String(showAvailability)); } catch { /* view preferences are optional */ } }, [hidden, showMarginsOnBars, showBaselineBars, showLeave, showAvailability]);
  // A mode owns the columns it talks about: a version in Monitoring reveals the
  // progress and consumption columns, so the effect of an edit is visible without
  // hunting through the View menu. This runs once per version-and-mode, so hiding
  // one of those columns again sticks for that mode.
  useEffect(() => {
    if (!activeVersionId) return;
    const key = activeVersionId + ":" + activeMode;
    try {
      if (localStorage.getItem("vintage-gantt-mode-columns") === key) return;
      localStorage.setItem("vintage-gantt-mode-columns", key);
    } catch { /* view preferences are optional */ }
    const emphasis = modeEmphasis[activeMode];
    setHidden((current) => {
      const next = current.filter((column) => !emphasis.includes(column));
      return next.length === current.length ? current : next;
    });
  }, [activeVersionId, activeMode]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [timelineDrag, setTimelineDrag] = useState<{ id: string; days: number } | null>(null);
  const [timelineResize, setTimelineResize] = useState<{ id: string; days: number; edge: "start" | "finish" } | null>(null);
  const [recalcDialog, setRecalcDialog] = useState(false);
  const [replanDialog, setReplanDialog] = useState(false);
  const [replanName, setReplanName] = useState("");
  const [replanScope, setReplanScope] = useState<ReplanScope>("not-started");
  const [replanPct, setReplanPct] = useState("20");
  const [activeBaselineId, setActiveBaselineId] = useState("");
  const [baselineDialog, setBaselineDialog] = useState(false);
  const [baselineName, setBaselineName] = useState("");
  const [baselineDate, setBaselineDate] = useState(todayLineDate);
  const [baselineSwitchPrompt, setBaselineSwitchPrompt] = useState(false);
  const [versionDialog, setVersionDialog] = useState(false);
  const [versionName, setVersionName] = useState("");
  const [templateDialog, setTemplateDialog] = useState(false);
  const [templateName, setTemplateName] = useState("");
  // Deleting a baseline is a row action: the row is picked first, then the
  // confirmation dialog (with the monitoring warning) works on that row.
  const [baselinePendingDelete, setBaselinePendingDelete] = useState<Baseline | null>(null);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [baselineOpen, setBaselineOpen] = useState(false);
  // Resource optimization: the preview is computed first and nothing changes
  // until "Apply" stores it as its own plan version.
  const [optimizePlan, setOptimizePlan] = useState<OptimizationPlan | null>(null);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  // The settings dialog comes before the run, so the fixed milestones are chosen
  // first. `null` means closed; a list of ids means open with that selection, and
  // the selection is only remembered when the optimization is actually run —
  // Cancel leaves the stored choice exactly as it was.
  const [optimizeSettings, setOptimizeSettings] = useState<string[] | null>(null);
  // The dialog's rows: every milestone of the open project (a zero-duration row
  // without children, the rule the Gantt grid uses), pre-ticked from the selection
  // remembered for this project. Purely derived — opening the dialog writes
  // nothing.
  const optimizeMilestoneChoices = useMemo(() => {
    if (!optimizeSettings) return [];
    const openTasks = projectTasks(activeProjectId);
    const milestones = openTasks.filter((task) => task.duration === 0 && !openTasks.some((child) => child.parentId === task.id));
    return fixedMilestoneChoices(milestones, optimizeSettings);
  }, [optimizeSettings, projectTasks, activeProjectId]);

  useEffect(() => {
    if (!resourceEditor) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".resource-combobox")) setResourceEditor(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [resourceEditor]);
  const [recalcDirection, setRecalcDirection] = useState<PlanningDirection>("forward");
  // The anchor the "plan the whole schedule" action starts from: today, never a fixed date.
  const [recalcDate, setRecalcDate] = useState(() => isoDate(new Date()));
  const [planningDirection, setPlanningDirection] = useState<PlanningDirection>("forward");
  const [projectDialog, setProjectDialog] = useState(false);
  const [pendingCalendarId, setPendingCalendarId] = useState(calendarId);
  const [relinkConfirm, setRelinkConfirm] = useState<{ calendarId: string; projects: number; tasks: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem("vintage-gantt-project-sidebar-collapsed", String(sidebarCollapsed)); } catch { /* storage is optional */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!marginNotice) return;
    const timer = setTimeout(() => setMarginNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [marginNotice]);

  useEffect(() => {
    if (!absorptionNotice) return;
    const timer = setTimeout(() => setAbsorptionNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [absorptionNotice]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  useEffect(() => {
    setProjectHighlight(0);
  }, [projectSearch, expandedGroups]);

  const [showCriticalPath, setShowCriticalPath] = useState(() => {
    try { return localStorage.getItem("vintage-gantt-show-critical-path") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("vintage-gantt-show-critical-path", String(showCriticalPath)); } catch { /* preference is optional */ }
  }, [showCriticalPath]);
  const calculatedTasks = useMemo(
    () => withCalculatedPlanningFields(tasks, system, calendarId),
    [tasks, system, calendarId],
  );
  // Leave overlap and availability per task. Purely informational (BES-004):
  // it never colours a row, blocks an edit or moves a date.
  const leaveInfo = useMemo(
    () => taskLeaveInfo(calculatedTasks, resources, assignments, system.exceptions, system),
    [calculatedTasks, resources, assignments, system],
  );
  // Overload is a cross-project figure and reuses the Capacity screen's own
  // engine, so the planner warning and the capacity panel can never disagree.
  // It is derived afresh from work, distribution, dates, assignments, capacity,
  // schedule and leave, so it follows any edit — in any project — immediately.
  const overloadIndex = useMemo(
    () => buildOverloadIndex({
      system,
      resources: resources.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId })),
      assignments,
      projects: selectCapacityProjects(projects).map((project) => ({
        projectId: project.id,
        projectName: project.name,
        projectCalendarId: project.calendarId,
        tasks: projectTasks(project.id),
      })),
    }),
    [system, resources, assignments, projects, projectTasks],
  );
  const taskOverload = useMemo(
    () => overloadByTask(overloadIndex, calculatedTasks, assignments),
    [overloadIndex, calculatedTasks, assignments],
  );
  const projectOverloadInfo = useMemo(
    () => projectOverload(overloadIndex, calculatedTasks, assignments),
    [overloadIndex, calculatedTasks, assignments],
  );
  const activeBaselineSnapshots = useMemo(
    () => new Map(baselineTasks.filter((snapshot) => snapshot.baselineId === activeBaselineId).map((snapshot) => [snapshot.taskId, snapshot])),
    [baselineTasks, activeBaselineId],
  );
  // Every saved baseline of this project, newest first. This is the list the
  // per-row delete actions live in, so it deliberately spans all versions.
  const projectBaselines = useMemo(
    () => baselines.filter((baseline) => baseline.projectId === activeProjectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [baselines, activeProjectId],
  );
  // What Monitoring compares against once the pending baseline is gone.
  const deleteBaselineFallback = useMemo(() => {
    if (!baselinePendingDelete) return null;
    return baselines
      .filter((baseline) => baseline.id !== baselinePendingDelete.id && baseline.versionId === baselinePendingDelete.versionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .pop() ?? null;
  }, [baselines, baselinePendingDelete]);
  // The chosen baseline is view state, not stored, so on load (or after
  // switching versions) fall back to the newest baseline captured on the
  // active version — the one the mode gate checks too.
  useEffect(() => {
    const versionBaselines = baselines.filter((baseline) => baseline.versionId === (activePlanVersion?.id ?? activeVersionId));
    setActiveBaselineId((current) => versionBaselines.some((baseline) => baseline.id === current)
      ? current
      : versionBaselines[versionBaselines.length - 1]?.id ?? "");
  }, [activeVersionId, activeProjectId, baselines, activePlanVersion?.id]);

  const visibleTasks = useMemo(() => {
    const visible: Task[] = [];
    // A summary has no float of its own, so it sorts on the tightest float in its
    // subtree and keeps its children nested underneath it.
    const sortableFloat = (task: Task): number => {
      const children = calculatedTasks.filter((candidate) => candidate.parentId === task.id);
      if (!children.length) return task.totalFloat ?? 0;
      return Math.min(...children.map(sortableFloat));
    };
    const sortableWork = (task: Task): number => {
      const children = calculatedTasks.filter((candidate) => candidate.parentId === task.id);
      if (!children.length) return task.isMilestone ? 0 : Math.max(0, task.work ?? 0);
      return children.reduce((sum, child) => sum + sortableWork(child), 0);
    };
    const walk = (parentId: string | null) => {
      const siblings = calculatedTasks.filter((task) => task.parentId === parentId);
      const ordered = sort?.key === "totalFloat"
        ? [...siblings].sort((left, right) => (sort.direction === "desc" ? -1 : 1) * (sortableFloat(left) - sortableFloat(right)))
        : sort?.key === "work"
          ? [...siblings].sort((left, right) => (sort.direction === "desc" ? -1 : 1) * (sortableWork(left) - sortableWork(right)))
          : siblings;
      ordered.forEach((task) => {
        if (!query || task.name.toLowerCase().includes(query.toLowerCase())) visible.push(task);
        if (!task.collapsed) walk(task.id);
      });
    };
    walk(null);
    return visible;
  }, [calculatedTasks, query, sort]);
  const taskDisplayIds = useMemo(
    () => new Map(orderTasksForDisplay(calculatedTasks).map((task, index) => [task.id, index + 1])),
    [calculatedTasks],
  );
  // Project-level margin totals (TC-42): the very same leaf-only figures the
  // margin report shows, so the planner and the report can never disagree.
  const marginTotals = useMemo(() => leafMarginTotals(marginRowsFor(calculatedTasks)), [calculatedTasks]);
  // The baseline the context bar names and compares against.
  const activeBaseline = baselines.find((baseline) => baseline.id === activeBaselineId) ?? null;

  
  const planningAnchor = new Date(`${todayLineDate}T12:00:00`);
  const taskTimestamps = calculatedTasks.flatMap((task) => [
    new Date(`${task.start}T12:00:00`).getTime(),
    new Date(`${task.finish}T12:00:00`).getTime(),
  ]);
  const projectStartDate = taskTimestamps.length ? new Date(Math.min(...taskTimestamps)) : parseDate(activeProject.startDate || todayLineDate);
  const projectFinishDate = taskTimestamps.length ? new Date(Math.max(...taskTimestamps)) : projectStartDate;
  const earliestTaskDate = projectStartDate;
  const latestTaskDate = projectFinishDate;
  const isTodayInProjectRange = todayLineDate >= dateLabel(projectStartDate) && todayLineDate <= dateLabel(projectFinishDate);
  const timelineStart = new Date(Math.min(earliestTaskDate.getTime(), planningAnchor.getTime()));
  timelineStart.setDate(timelineStart.getDate() - 14);
  const timelineEnd = new Date(Math.max(latestTaskDate.getTime(), planningAnchor.getTime()));
  timelineEnd.setDate(timelineEnd.getDate() + 14);
  const requiredTimelineDays = Math.max(1, Math.ceil((timelineEnd.getTime() - timelineStart.getTime()) / 86400000) + 1);
  const minimumTimelineDays = zoom === "month" ? 100 : zoom === "quarter" ? 180 : 62;
  const timelineDays = Array.from({ length: Math.max(requiredTimelineDays, minimumTimelineDays) }, (_, index) => {
    const day = new Date(timelineStart);
    day.setDate(day.getDate() + index);
    return day;
  });
  const dayWidth = zoom === "day" ? 48 : zoom === "week" ? 17 : zoom === "month" ? 9 : 5;
  const timelineWidth = timelineDays.length * dayWidth;
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller || !activeProjectId || !activeVersionId) return;
    const targetDate = isTodayInProjectRange ? todayLineDate : dateLabel(projectStartDate);
    const targetOffset = Math.round((parseDate(targetDate).getTime() - timelineStart.getTime()) / 86400000) * dayWidth;
    scroller.scrollLeft = Math.max(0, targetOffset - dayWidth * 7);
  }, [activeProjectId, activeVersionId, zoom]);
  const taskById = new Map(calculatedTasks.map((task) => [task.id, task]));
  const isMilestone = (task: Task) => task.duration === 0 && !calculatedTasks.some((candidate) => candidate.parentId === task.id);
  const assignedResources = (taskId: string) => assignments.filter((assignment) => assignment.taskId === taskId).map((assignment) => resources.find((resource) => resource.id === assignment.resourceId)).filter(Boolean);
  const dayIsWorking = (date: string) => resolveWorkingDay(date, calendarId, system);
  const filteredProjectGroups = useMemo(() => {
    const matching = projects.filter((project) => (project.kind ?? "project") === "project" && project.name.toLowerCase().includes(projectSearch.toLowerCase()));
    return {
      active: matching.filter((project) => project.status === "active"),
      archived: matching.filter((project) => project.status === "archived"),
    };
  }, [projects, projectSearch]);
  const projectResults = [...filteredProjectGroups.active, ...filteredProjectGroups.archived];
  const selectProject = (projectId: string) => {
    if (projectId === activeProjectId) return;
    if (editing) updateTask(editing.id, editing.field, draft);
    setEditing(null);
    setResourceEditor(null);
    setHistory([]);
    setFuture([]);
    setActiveProject(projectId);
  };
  // There is exactly one search field in the interface, so it drives both the
  // project sidebar and the task grid. Its placeholder says so.
  const applySearch = (value: string) => {
    setQuery(value);
    setProjectSearch(value);
    setSearchParams(value ? { q: value } : {}, { replace: true });
  };

  const recalculate = (
    next: Task[],
    direction: PlanningDirection = "forward",
    resetDates = false,
    anchorDate = "",
    anchoredTaskIds: string[] = [],
  ) => {
    const normalized = normalizeMilestones(next);
    const result = recalculateTasks(normalized, {
      direction: resetDates ? direction : "forward",
      projectStart: resetDates && direction === "forward" ? anchorDate : undefined,
      projectFinish: resetDates && direction === "backward" ? anchorDate : undefined,
      calendarSystem: system,
      projectCalendarId: calendarId,
      resetDates,
      anchoredTaskIds: resetDates ? [] : anchoredTaskIds,
    });
    if (result.error) {
      toast.error(result.error);
      setTasks(next);
      return;
    }
    setTasks(withCalculatedPlanningFields(result.tasks, system, calendarId));
  };

  const normalizeMilestones = (items: Task[]) => items.map((task) => ({
    ...task,
    isMilestone: task.duration === 0 && !items.some((candidate) => candidate.parentId === task.id),
  }));

  const commit = (next: Task[], manuallyAnchoredId?: string) => {
    const normalized = normalizeMilestones(next);
    const cycle = findDependencyCycle(normalized, dependenciesForTasks(normalized));
    if (cycle) {
      toast.error(`Dependency rejected: circular chain ${cycle.join(" → ")} would freeze the schedule.`);
      return false;
    }
    setHistory((items) => [...items.slice(-29), tasks]);
    setFuture([]);
    const anchored = manuallyAnchoredId ? [manuallyAnchoredId] : [];
    if (activeMode === "planning") {
      // Planning re-plans: margin is sized from the percentage, nothing is consumed.
      recalculate(applyPlanningModeMargins(normalized), "forward", false, "", anchored);
      return true;
    }
    // Monitoring: margin is consumed by the FINISH move, whatever caused it. Each
    // task's own remaining reserve absorbs the movement first and only the excess
    // reaches its successors. Settling to a fixed point means a delay that an
    // upstream reserve ultimately soaks up no longer eats a downstream reserve.
    const settled = settleMonitoringPlan(tasks, normalized, { calendarSystem: system, projectCalendarId: calendarId, anchoredTaskIds: anchored });
    recalculate(settled.tasks, "forward", false, "", anchored);
    const relevant = settled.changes.filter((change) => change.absorbed || change.passed || change.returned);
    const focus = relevant.find((change) => change.taskId === manuallyAnchoredId)
      ?? [...relevant].sort((a, b) => (b.absorbed + b.passed + b.returned) - (a.absorbed + a.passed + a.returned))[0];
    if (focus) setAbsorptionNotice({ taskId: focus.taskId, message: formatAbsorption(focus) });
    return true;
  };

  /* ------------------------------------------- adjust remaining work (Monitoring) */

  /** The employee an adjustment is measured against (the task's first assignment). */
  const taskResourceFor = (taskId: string) => resources.find((resource) => assignments.some((assignment) => assignment.taskId === taskId && assignment.resourceId === resource.id));

  const adjustmentContext = (task: Task) => {
    const resource = taskResourceFor(task.id);
    const hoursFor = resource ? (date: string) => availableHours(resource, date, system) : undefined;
    return {
      system,
      projectCalendarId: calendarId,
      isAvailable: hoursFor ? (date: string) => hoursFor(date) > 0 : undefined,
      availableHours: hoursFor,
      today: todayLineDate,
    };
  };

  /** The workload the active baseline recorded for a task, if it captured one. */
  const baselineWorkFor = (taskId: string) => activeBaselineSnapshots.get(taskId)?.work;

  /**
   * Applies the adjustment through the normal commit path, so margin consumption,
   * successor movement and history behave exactly like any other Monitoring edit.
   * Editing the most recent adjustment goes through the same path, with the same
   * preview and validation.
   */
  const runAdjustmentPlan = (task: Task, input: AdjustmentInput, editing: boolean) => {
    const options = { baselineWork: baselineWorkFor(task.id), actor: adjustmentActor, at: new Date().toISOString() };
    const plan = editing
      ? editLastAdjustment(tasks, task.id, input, adjustmentContext(task), options)
      : planAdjustment(tasks, task.id, input, adjustmentContext(task), options);
    if ("error" in plan) {
      setAdjustError(plan.error);
      return;
    }
    setAdjustError(null);
    // Only the adjusted task is handed on; commit re-schedules the network itself,
    // so successors move exactly as the preview promised instead of absorbing margin.
    commit(tasks.map((item) => (item.id === task.id ? plan.task : item)), task.id);
    setAdjustTaskId(null);
    setAdjustEdit(null);
    setModalTask(null);
    toast.success(editing
      ? "Adjustment updated."
      : `Remaining work adjusted: ${displayHours(plan.preview.fixedHours)} h kept, ${displayHours(plan.preview.remainingHours)} h re-planned.`);
  };

  /**
   * Removes the most recent adjustment, or all of them. The state goes back
   * exactly as it was, and every removed entry stays in the log, marked with who
   * removed it and when.
   */
  const confirmRemoval = (task: Task, mode: "last" | "all") => {
    const at = new Date().toISOString();
    const restored = mode === "all"
      ? removeAllAdjustments(task, adjustmentActor, at)
      : removeLastAdjustment(task, adjustmentActor, at);
    if (!restored) return;
    commit(tasks.map((item) => (item.id === task.id ? restored : item)), task.id);
    setRemovalPrompt(null);
    setModalTask(restored);
    toast(mode === "all" ? "All adjustments removed" : "Adjustment removed");
  };

  /** Applies one cell edit and returns the task list it committed, so callers can
   *  chain another change (a new row) onto the result instead of onto stale state. */
  const updateTask = (id: string, field: ColumnKey, value: string): Task[] | undefined => {
    // A field owned by the other mode never changes here, even if some event
    // slips through the readonly cells.
    if (fieldModeReadOnly(field, activeMode)) { setEditing(null); return; }
    if (field === "predecessors") {
      const resolved = resolvePredecessorInput(value, id, tasks, taskDisplayIds);
      if (resolved.error) {
        setCellError({ taskId: id, column: "predecessors", message: resolved.error });
        setEditing(null);
        return;
      }
      setCellError(null);
      commit(tasks.map((task) => task.id === id ? { ...task, predecessors: resolved.value ?? "" } : task));
      setEditing(null);
      return;
    }
    setCellError(null);
    setMarginNotice(null);
    setAbsorptionNotice(null);
    const next = tasks.map((task) => {
      if (task.id !== id) return task;
      if (field === "duration") {
        const parsed = parseDurationInput(value, { amount: task.duration, unit: task.durationUnit });
        const duration = parsed.amount;
        const weeks = parsed.unit === "weeks";
        const summary = tasks.some((candidate) => candidate.parentId === task.id);
        const milestone = duration === 0 && !summary;
        return {
          ...task,
          duration,
          durationUnit: parsed.unit,
          isMilestone: milestone,
          finish: milestone
            ? task.start
            : addWorkingDays(task.start, weeks ? duration * 5 - 1 : Math.max(0, duration - 1), calendarId, system),
        };
      }
      if (field === "work") {
        // Work is data only: whole or half hours, minimum 0. It never changes
        // duration or any date, and a milestone carries no work at all.
        if (task.duration === 0 && !tasks.some((candidate) => candidate.parentId === task.id)) return task;
        return { ...task, work: normalizeWorkHours(value) };
      }
      if (field === "distribution") {
        // Distribution is data only, like Work: it is never a scheduling input.
        return { ...task, distribution: normalizeDistribution(value) };
      }
      if (field === "start") {
        const start = value || task.start;
        const milestone = task.duration === 0 && !tasks.some((candidate) => candidate.parentId === task.id);
        // A start later than the dependencies allow is the user's intent: store it
        // as a "start no earlier than" constraint so recalculation keeps it. An
        // earlier date is still rejected below.
        const normalized = ensureWorkingDay(start, calendarId, system);
        const startConstraint = startConstraintFor(task, normalized, tasks, system, calendarId, taskDisplayIds);
        return {
          ...task,
          start,
          isMilestone: milestone,
          startConstraint,
          finish: milestone
            ? start
            : addWorkingDays(start, task.durationUnit === "weeks" ? task.duration * 5 - 1 : Math.max(0, task.duration - 1), calendarId, system),
        };
      }
      if (field === "finish") {
        const finish = value || task.finish;
        if (task.duration === 0 && !tasks.some((candidate) => candidate.parentId === task.id)) return { ...task, start: finish, finish, isMilestone: true };
        const duration = workingDaysBetween(task.start, finish, calendarId, system);
        const start = addWorkingDays(finish, -(duration - 1), calendarId, system);
        return { ...task, start, finish, duration, durationUnit: "days" as const };
      }
      if (field === "margin") {
        const marginPct = Math.max(0, Math.min(100, Number(value.replace("%", "")) || 0));
        // A repeat of the same value (e.g. blur right after Enter) must not clear
        // a restore notice that was just shown.
        if ((task.marginPct ?? 0) === marginPct) return task;
        const before = remainingMarginDays(task);
        const after = marginAfterPctChange(task, marginPct);
        // A task that had spent its whole reserve and gains real reserve back must
        // say so instead of appearing to change silently.
        setMarginNotice(before === 0 && after.remaining > 0
          ? { taskId: task.id, message: `Margin restored: +${after.remaining} d reserve (${after.original} d original − ${after.consumed} d consumed).` }
          : null);
        return { ...task, marginPct };
      }
      if (field === "percent") return { ...task, percent: Math.max(0, Math.min(100, Number(value.replace("%", "")) || 0)) };
      if (field === "actualStart") return { ...task, actualStart: value.trim() || undefined };
      if (field === "actualFinish") return { ...task, actualFinish: value.trim() || undefined };
      if (field === "name") return { ...task, name: value.trim() || task.name };
      return { ...task, [field]: value };
    });
    // The name is settled now, so the field stops showing the "New task" placeholder.
    if (field === "name" && id === namingTaskId) setNamingTaskId(null);
    // Start and finish of a task with predecessors are derived from the network, so
    // a date that breaks a dependency is refused rather than silently corrected.
    if (field === "start" || field === "finish") {
      const edited = next.find((task) => task.id === id);
      const violation = edited
        ? startEditRestriction(edited, edited.start, tasks, system, calendarId, taskDisplayIds)
        : null;
      if (violation) {
        setCellError({ taskId: id, column: field, message: violation });
        setEditing(null);
        return;
      }
    }
    const accepted = commit(next);
    setEditing(null);
    return accepted ? next : undefined;
  };

  /**
   * Drops a task's "start no earlier than" constraint, so the next pass returns
   * it to the earliest start its dependencies allow.
   */
  const removeConstraint = (id: string) => {
    commit(tasks.map((task) => (task.id === id ? { ...task, startConstraint: undefined, startConstraintActive: false } : task)));
    toast("Start constraint removed");
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setFuture((items) => [tasks, ...items]);
    setTasks(previous);
    setHistory((items) => items.slice(0, -1));
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((items) => [...items, tasks]);
    setTasks(next);
    setFuture((items) => items.slice(1));
  };

  /** A free task id: two rows created in the same millisecond must still differ. */
  const nextTaskId = (items: Task[] = tasks) => {
    let id = String(Date.now());
    while (items.some((item) => item.id === id)) id = String(Number(id) + 1);
    return id;
  };

  /**
   * The start date a brand-new task gets: today on the project calendar, moved to
   * the next working day when today is a weekend, holiday or closure. Dependencies
   * and the surrounding network still win — `commit` re-plans the row right after,
   * exactly as it already does for every other new task.
   */
  const defaultTaskStart = () => ensureWorkingDay(isoDate(new Date()), calendarId, system);

  /** A fresh row. Its name is only the fallback until the user confirms a name. */
  const newTaskRow = (id: string, parentId: string | null): Task => {
    const start = defaultTaskStart();
    return {
      id,
      parentId,
      name: "New task",
      duration: 1,
      durationUnit: "days",
      work: 0,
      start,
      finish: start,
      isMilestone: false,
      predecessors: "",
      resource: "",
      percent: 0,
      notes: "",
      color: "sage",
    };
  };

  /** Opens the name field of a fresh, empty row. */
  const openNameEditor = (id: string) => {
    setSelected([id]);
    setEditing({ id, field: "name" });
    setDraft("");
    setNamingTaskId(id);
  };

  const addTask = (parentId: string | null = null, afterId?: string, base: Task[] = tasks) => {
    const id = nextTaskId(base);
    const index = afterId ? base.findIndex((item) => item.id === afterId) + 1 : base.length;
    const next = [...base.slice(0, index), newTaskRow(id, parentId), ...base.slice(index)];
    openNameEditor(id);
    commit(next);
  };

  /**
   * Confirms the pending row's typed name and opens the next empty row directly
   * below it in ONE commit. Committing twice would rebuild the second change from
   * the task list as it was before the first one, which is how a typed name used to
   * be replaced by the "New task" placeholder again.
   */
  const confirmNewTaskName = (task: Task) => {
    const renamed = tasks.map((item) => item.id === task.id ? { ...item, name: draft.trim() || item.name } : item);
    const id = nextTaskId(renamed);
    const index = renamed.findIndex((item) => item.id === task.id) + 1;
    const next = [...renamed.slice(0, index), newTaskRow(id, task.parentId), ...renamed.slice(index)];
    openNameEditor(id);
    commit(next);
  };

  /** Escape on a row that was never named drops it again: nothing is saved, and the
   *  undo step its insertion added is taken back with it. */
  const cancelNewTask = () => {
    const id = namingTaskId;
    if (!id) return;
    setNamingTaskId(null);
    setEditing(null);
    setSelected((items) => items.filter((item) => item !== id));
    setHistory((items) => items.slice(0, -1));
    setTasks((items) => items.filter((item) => item.id !== id));
  };

  // Deleting goes to the database first and the answer is awaited. Only a
  // confirmed delete changes the plan here; a refusal keeps every row and says
  // what went wrong, so a task can never look deleted while the server keeps it.
  const deleteSelected = async () => {
    if (!selected.length) return;
    const wanted = tasks.filter((task) => selected.includes(task.id) || selected.includes(task.parentId ?? "")).map((task) => task.id);
    const result = await deleteTasks(activeProjectId, wanted);
    if (!result.ok) {
      toast.error(result.message ?? "The task could not be deleted.");
      return;
    }
    // Exactly what the database removed leaves the plan — including the whole
    // subtree of a removed parent, so nothing is left pointing at a gone task.
    const removed = new Set(result.removedTaskIds);
    commit(tasks.filter((task) => !removed.has(task.id)));
    setSelected([]);
  };

  /**
   * Duplicates a task together with every task below it, at all levels.
   *
   * The copies keep their structure, order, names, durations, dates and every
   * other field, land right below the original subtree, and belong to this
   * project and active version (the company is the signed-in one — the browser
   * never supplies it). Dependencies inside the group are re-pointed to the new
   * copies, while a dependency that leaves the group is left out entirely: the
   * original plan is untouched and the user is told. Assignments travel with the
   * rows, and `commit` re-plans the network exactly as it does for a manual edit,
   * so workload and capacity follow. Nothing is created when the copy is refused.
   */
  const duplicateTask = (sourceId: string) => {
    const used = new Set(tasks.map((item) => item.id));
    const nextId = () => {
      let id = String(Date.now());
      while (used.has(id)) id = String(Number(id) + 1);
      used.add(id);
      return id;
    };
    const result = duplicateTaskGroup(tasks, sourceId, () => nextId());
    if (result.error || !result.group) {
      toast.error(result.error ?? "The task could not be duplicated.");
      return;
    }
    const { tasks: copies, idMap, droppedDependencies } = result.group;
    // The copies go directly under the original subtree, so the new rows read in
    // the same order and nesting as the ones they came from.
    const lastIndex = tasks.reduce((last, item, index) => (idMap.has(item.id) ? index : last), -1);
    const next = [...tasks.slice(0, lastIndex + 1), ...copies, ...tasks.slice(lastIndex + 1)];
    if (!commit(next)) return;
    // Assignments are a separate table, so they are copied task by task onto the
    // new rows. Workload and capacity read them, so the copy counts as planned.
    for (const [newTaskId, resourceIds] of duplicateTaskAssignments(assignments, idMap)) {
      setTaskAssignments(newTaskId, resourceIds);
    }
    toast(droppedDependencies.length
      ? `Task duplicated. ${droppedDependencies.length} dependenc${droppedDependencies.length === 1 ? "y" : "ies"} pointing outside the copy were not copied.`
      : "Task duplicated");
  };

  const taskDepth = (task: Task, items: Task[] = tasks) => {
    let depth = 0;
    let parentId = task.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = items.find((item) => item.id === parentId)?.parentId ?? null;
    }
    return depth;
  };

  const taskSubtreeIds = (id: string, items: Task[]) => {
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of items) {
        if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true; }
      }
    }
    return ids;
  };

  const indent = (id: string, outdent = false) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) return;
    const task = tasks[index];
    const currentDepth = taskDepth(task);
    const subtree = taskSubtreeIds(id, tasks);
    if (outdent) {
      if (!task.parentId) return;
      const formerParent = tasks.find((item) => item.id === task.parentId);
      if (!formerParent) return;
      const nextParentId = formerParent.parentId ?? null;
      const moved = tasks.filter((item) => subtree.has(item.id));
      const remaining = tasks.filter((item) => !subtree.has(item.id));
      const parentSubtree = taskSubtreeIds(formerParent.id, remaining);
      let insertAt = 0;
      remaining.forEach((item, itemIndex) => { if (parentSubtree.has(item.id)) insertAt = Math.max(insertAt, itemIndex + 1); });
      const next = [...remaining.slice(0, insertAt), ...moved.map((item) => ({ ...item, parentId: item.id === id ? nextParentId : item.parentId })), ...remaining.slice(insertAt)];
      commit(next);
      return;
    }
    const visibleIndex = visibleTasks.findIndex((item) => item.id === id);
    if (visibleIndex <= 0) return;
    const preceding = visibleTasks[visibleIndex - 1];
    const newDepth = currentDepth + 1;
    if (newDepth > taskDepth(preceding) + 1) return;
    const target = [...visibleTasks].slice(0, visibleIndex).reverse().find((item) => taskDepth(item) === newDepth - 1);
    if (!target || task.parentId === target.id) return;
    commit(tasks.map((item) => item.id === id ? { ...item, parentId: target.id } : item));
  };

  const toggleCollapse = (id: string) =>
    setTasks((items) => items.map((task) => (task.id === id ? { ...task, collapsed: !task.collapsed } : task)));

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") redo();
      if (event.key === "Delete" && !editing) deleteSelected();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  const handleKey = (event: ReactKeyboardEvent, task: Task, field: ColumnKey) => {
    if (event.key === "Escape") {
      // Escape on a row that was never named cancels the creation: nothing is saved.
      if (task.id === namingTaskId) cancelNewTask();
      else setEditing(null);
      setCellError(null);
      setMarginNotice(null);
      setAbsorptionNotice(null);
      return;
    }
    if (event.key !== "Enter" && event.key !== "Tab") return;
    event.preventDefault();
    // Enter while naming a fresh row saves exactly what was typed and opens the next
    // empty row after it, so several tasks can be typed in sequence.
    if (event.key === "Enter" && field === "name" && task.id === namingTaskId) {
      confirmNewTaskName(task);
      return;
    }
    const committed = updateTask(task.id, field, draft);
    const columnIndex = columnDefs.findIndex((column) => column.key === field);
    const nextColumn = event.shiftKey
      ? columnDefs[Math.max(0, columnIndex - 1)]
      : columnDefs[Math.min(columnDefs.length - 1, columnIndex + 1)];
    if (event.key === "Enter") {
      const rowIndex = visibleTasks.findIndex((item) => item.id === task.id);
      const nextRow = visibleTasks[rowIndex + 1];
      if (nextRow) {
        setSelected([nextRow.id]);
        setEditing({ id: nextRow.id, field });
        setDraft(String((nextRow as unknown as Record<string, unknown>)[field] ?? ""));
      } else addTask(task.parentId, undefined, committed ?? tasks);
    } else if (nextColumn) {
      setEditing({ id: task.id, field: nextColumn.key });
      setDraft(String((task as unknown as Record<string, unknown>)[nextColumn.key] ?? ""));
    }
  };

  const taskTop = (id: string) => visibleTasks.findIndex((task) => task.id === id) * rowHeight;
  const dateOffset = (date: string) =>
    Math.round((new Date(`${date}T12:00:00`).getTime() - timelineStart.getTime()) / 86400000) * dayWidth;
  const barWidth = (task: Task) =>
    Math.max(
      isMilestone(task) ? 14 : 22,
      (Math.round((new Date(`${task.finish}T12:00:00`).getTime() - new Date(`${task.start}T12:00:00`).getTime()) / 86400000) + 1) *
        dayWidth,
    );

  const beginBarDrag = (event: ReactPointerEvent, task: Task) => {
    if (isMilestone(task)) return;
    event.stopPropagation();
    const originX = event.clientX;
    let movedDays = 0;
    const move = (moveEvent: PointerEvent) => {
      movedDays = Math.round((moveEvent.clientX - originX) / dayWidth);
      setTimelineDrag({ id: task.id, days: movedDays });
    };
    const up = () => {
      if (movedDays !== 0) {
        const start = addWorkingDays(task.start, movedDays, calendarId, system);
        const finish = addWorkingDays(task.finish, movedDays, calendarId, system);
        // A drag may never pull a task before its predecessors allow: the bar snaps
        // back to where it was and the reason is shown on the row.
        const violation = startEditRestriction({ ...task, start, finish }, start, tasks, system, calendarId, taskDisplayIds);
        if (violation) {
          setCellError({ taskId: task.id, column: "start", message: violation });
        } else {
          commit(tasks.map((item) => (item.id === task.id ? { ...item, start, finish, startConstraint: startConstraintFor(task, start, tasks, system, calendarId, taskDisplayIds) } : item)), task.id);
          toast(`${task.name} moved to ${formatDate(start)}`);
        }
      }
      setTimelineDrag(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const beginBarResize = (event: ReactPointerEvent, task: Task, edge: "start" | "finish") => {
    event.stopPropagation();
    const originX = event.clientX;
    let movedDays = 0;
    const move = (moveEvent: PointerEvent) => {
      movedDays = Math.round((moveEvent.clientX - originX) / dayWidth);
      setTimelineResize({ id: task.id, edge, days: movedDays });
    };
    const up = () => {
      if (movedDays !== 0) {
        let start = task.start;
        let finish = task.finish;
        if (edge === "start") start = addWorkingDays(task.start, movedDays, calendarId, system);
        else finish = addWorkingDays(task.finish, movedDays, calendarId, system);
        if (start >= finish) {
          if (edge === "start") start = addWorkingDays(finish, -1, calendarId, system);
          else finish = addWorkingDays(start, 1, calendarId, system);
        }
        const duration = workingDaysBetween(start, finish, calendarId, system);
        const resized = { ...task, start, finish, duration, durationUnit: "days" as const };
        // Only the start edge can break a dependency; the finish edge keeps the start.
        const violation = edge === "start"
          ? startEditRestriction(resized, start, tasks, system, calendarId, taskDisplayIds)
          : null;
        if (violation) {
          setCellError({ taskId: task.id, column: "start", message: violation });
        } else {
          commit(tasks.map((item) => (item.id === task.id ? { ...resized, startConstraint: edge === "start" ? startConstraintFor(task, start, tasks, system, calendarId, taskDisplayIds) : item.startConstraint } : item)), task.id);
          toast(`${task.name} duration set to ${duration} working days`);
        }
      }
      setTimelineResize(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dependencyLinks = visibleTasks.flatMap((successor) =>
    dependenciesForTasks(tasks)
      .filter((dependency) => dependency.successorId === successor.id)
      .flatMap((dependency) => {
        const predecessor = taskById.get(dependency.predecessorId);
        if (!predecessor || !visibleTasks.some((task) => task.id === predecessor.id)) return [];
        // The link leaves the end of the predecessor's slot, so a successor that
        // starts after the margin zone is drawn from where it may actually start.
        const predecessorMargin = remainingMarginDays(predecessor);
        const marginZoneWidth = predecessorMargin > 0
          ? dateOffset(addWorkingDays(predecessor.finish, predecessorMargin, calendarId, system)) - dateOffset(predecessor.finish)
          : 0;
        const x1 = dateOffset(predecessor.start) + barWidth(predecessor) + marginZoneWidth;
        const x2 = dateOffset(successor.start);
        const y1 = taskTop(predecessor.id) + rowHeight / 2;
        const y2 = taskTop(successor.id) + rowHeight / 2;
        const elbowX = x2 >= x1 ? x1 + Math.max(18, (x2 - x1) * 0.55) : x1 + 18;
        return [{
          ...dependency,
          predecessor,
          successor,
          x1,
          x2,
          y1,
          y2,
          path: x2 >= x1 ? `M ${x1} ${y1} H ${elbowX} V ${y2} H ${x2}` : `M ${x1} ${y1} H ${x1 + 18} V ${y2} H ${x2 - 12} V ${y2}`,
        }];
      }),
  );

  const projectStartIso = dateLabel(earliestTaskDate);
  const projectFinishIso = dateLabel(latestTaskDate);
  const referenceDateFor = (direction: PlanningDirection) => (direction === "forward" ? projectStartIso : projectFinishIso);
  const openRecalculate = () => {
    setRecalcDirection(planningDirection);
    setRecalcDate(referenceDateFor(planningDirection));
    setRecalcDialog(true);
  };
  const choosePlanningDirection = (direction: PlanningDirection) => {
    setRecalcDirection(direction);
    setRecalcDate(referenceDateFor(direction));
  };
  const openProjectSettings = () => {
    setPendingCalendarId(calendarId);
    setProjectDialog(true);
  };
  const requestCalendarChange = () => {
    if (pendingCalendarId === calendarId) {
      setProjectDialog(false);
      return;
    }
    const impact = previewProjectRelink(activeProject.id, pendingCalendarId);
    setProjectDialog(false);
    setRelinkConfirm({ calendarId: pendingCalendarId, projects: impact.projects, tasks: impact.tasks });
  };

  const replanMarginPct = Math.max(0, Math.min(100, Number(replanPct.replace("%", "")) || 0));
  // The dialog preview runs the same forward pass the store will: rewrite the
  // margins in scope, then schedule. Only the ids differ afterwards, so the
  // predicted finish here is the finish the confirmed replan actually plans.
  const replanPreview = useMemo(() => {
    if (!replanDialog) return null;
    const input = { scope: replanScope, selectedTaskIds: selected, marginPct: replanMarginPct };
    const adjusted = applyReplanMargins(tasks, input);
    const result = recalculateTasks(adjusted, { direction: "forward", calendarSystem: system, projectCalendarId: calendarId });
    const scheduled = result.error ? adjusted : withCalculatedPlanningFields(result.tasks, system, calendarId);
    return { affected: replanScopeIds(tasks, input).size, finish: planFinishDate(scheduled) };
  }, [replanDialog, replanScope, replanMarginPct, selected, tasks, system, calendarId]);
  const openReplan = () => {
    setReplanName(`Replan ${formatDate(todayLineDate)}`);
    setReplanScope("not-started");
    setReplanPct("20");
    setReplanDialog(true);
    setOverflowOpen(false);
  };
  const confirmReplan = () => {
    const result = replanProject({ name: replanName, scope: replanScope, selectedTaskIds: selected, marginPct: replanMarginPct });
    if (!result.ok) { toast.error(result.message ?? "Could not create the replan."); return; }
    setHistory([]);
    setFuture([]);
    setReplanDialog(false);
    toast.success(`Replanned ${result.affected} task${result.affected === 1 ? "" : "s"} · finish ${formatDate(result.finish)}`);
  };
  const switchToMonitoring = () => {
    const result = setPlanMode(activeVersionId, "monitoring");
    if (!result.ok) { toast.error(result.message ?? "Could not switch mode."); return; }
    setHistory([]);
    setFuture([]);
    setModeMenuOpen(false);
    toast.success("This version is now in Monitoring mode");
  };
  // The report looks at the active project and plan version only; when a baseline
  // is being viewed, hand it over so "became critical" compares the right float.
  const openMarginReport = () => {
    setOverflowOpen(false);
    navigate(activeBaselineId ? `/reports/margins?baseline=${encodeURIComponent(activeBaselineId)}` : "/reports/margins");
  };
  // The overload indicators open the same capacity panel, filtered on the person
  // (clicking a warning icon) or the project (clicking the context-bar chip), so
  // the user can see the cause. Nothing here changes the plan (BES-008).
  const openResourceCapacity = (weeks: OverloadWeek[]) => {
    const first = weeks[0];
    if (!first) return;
    navigate(`/capacity?resource=${encodeURIComponent(first.resourceId)}&week=${encodeURIComponent(first.weekStart)}`);
  };
  const openProjectCapacity = () => {
    navigate(`/capacity?project=${encodeURIComponent(activeProjectId)}`);
  };
  // Capturing a baseline is the door into Monitoring: the plan is frozen as the
  // reference, then we offer the switch. "Later" leaves it locked open.
  const openBaseline = () => {
    const count = baselines.filter((baseline) => baseline.projectId === activeProjectId).length + 1;
    setBaselineName(`Baseline ${count}`);
    setBaselineDate(todayLineDate);
    setBaselineDialog(true);
    setOverflowOpen(false);
    setBaselineOpen(false);
  };
  const confirmBaseline = () => {
    const id = createBaseline(baselineName.trim() || "Baseline", undefined, baselineDate);
    setActiveBaselineId(id);
    setBaselineDialog(false);
    toast.success(`Baseline captured: ${baselineName.trim() || "Baseline"}`);
    setBaselineSwitchPrompt(true);
  };
  // Native prompts are blocked in the embedded preview, so new versions, saving
  // templates and deleting a baseline all go through their own dialog.
  const projectVersionCount = planVersions.filter((version) => version.projectId === activeProjectId).length;
  const openNewVersion = () => {
    setVersionName(`Version ${projectVersionCount + 1}`);
    setVersionDialog(true);
    setOverflowOpen(false);
  };
  const confirmNewVersion = () => {
    const result = createPlanVersion(versionName.trim() || `Version ${projectVersionCount + 1}`);
    if (!result.ok) { toast.error(result.message ?? "Could not create the version."); return; }
    setHistory([]);
    setFuture([]);
    setVersionDialog(false);
    toast.success("New version created in Planning mode");
  };
  /**
   * Resource optimization: the settings dialog first, then a preview.
   *
   * Opening the dialog changes nothing at all: it only reads the milestones of the
   * open project and the selection remembered for it. The whole company's active
   * versions are handed in — so every employee's occupancy counts the work of the
   * other projects — but only this project's rows are ever returned as movable.
   * Nothing is written: the result is shown first, and only "Apply" turns it into
   * a new plan version.
   */
  const openOptimizeSettings = () => {
    setOverflowOpen(false);
    setOptimizePlan(null);
    setOptimizeError(null);
    setOptimizeSettings(loadFixedMilestones(activeProjectId));
  };
  /** Cancel changes nothing: the dialog simply closes, nothing is remembered. */
  const cancelOptimizeSettings = () => setOptimizeSettings(null);
  const runOptimize = () => {
    // The chosen milestones are remembered for this project, so the dialog comes
    // back with the same boxes ticked.
    const fixedMilestoneIds = optimizeSettings ?? [];
    saveFixedMilestones(activeProjectId, fixedMilestoneIds);
    setOptimizeSettings(null);
    const result = optimizeProject({
      projectId: activeProjectId,
      projects: selectCapacityProjects(projects).map((project) => ({
        projectId: project.id,
        projectName: project.name,
        projectCalendarId: project.calendarId,
        tasks: projectTasks(project.id),
      })),
      resources: resources.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId })),
      assignments,
      system,
      mode: activeMode,
      today: todayLineDate,
      fixedMilestoneIds,
    });
    if (!result.ok) {
      setOptimizePlan(null);
      setOptimizeError(result.error);
      return;
    }
    setOptimizeError(null);
    setOptimizePlan(result);
  };
  const cancelOptimize = () => {
    // Cancel changes nothing: the preview is simply dropped.
    setOptimizePlan(null);
    setOptimizeError(null);
  };
  /**
   * Apply stores the optimized planning as a new plan version through the same
   * version management as "New version": the current version is left untouched
   * so the user can always go back, and the copy is one complete action — a
   * refused copy creates nothing.
   */
  const applyOptimize = () => {
    if (!optimizePlan) return;
    const result = createPlanVersion(`Optimized ${formatDate(todayLineDate)}`, optimizePlan.tasks);
    if (!result.ok) {
      toast.error(result.message ?? "The optimized version could not be created.");
      return;
    }
    setHistory([]);
    setFuture([]);
    setOptimizePlan(null);
    toast.success("Optimized planning saved as a new version. The original version is unchanged.");
  };
  const openSaveTemplate = () => {
    setTemplateName(`${activeProject.name} template`);
    setTemplateDialog(true);
    setOverflowOpen(false);
  };
  const confirmSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) return;
    setTemplateDialog(false);
    void saveAsTemplate(activeProject.id, activeVersionId, name).then(() => toast.success("Template saved")).catch((error) => toast.error(error instanceof Error ? error.message : "Could not save template."));
  };
  const requestDeleteBaseline = (baseline: Baseline) => {
    setBaselineError(null);
    setBaselinePendingDelete(baseline);
    setBaselineOpen(false);
    setOverflowOpen(false);
  };
  const closeDeleteBaseline = () => {
    setBaselinePendingDelete(null);
    setBaselineError(null);
  };
  const confirmDeleteBaseline = () => {
    if (!baselinePendingDelete) return;
    // Snapshot rows are removed in the same update as the baseline itself, and
    // the comparison falls back to the newest baseline that is left.
    const result = deleteBaseline(baselinePendingDelete.id);
    if (!result.ok) {
      // Deletion never fails silently: the reason stays visible in the dialog.
      console.error("[vintage-gantt] could not delete baseline", baselinePendingDelete, result);
      setBaselineError(result.message ?? "The baseline could not be deleted.");
      return;
    }
    setActiveBaselineId(result.fallbackBaselineId ?? "");
    toast.success(`Baseline “${baselinePendingDelete.name}” deleted`);
    closeDeleteBaseline();
  };
  const versionHistory = activePlanVersion?.history ?? [];
  const modeEvents = versionHistory.filter((event) => event.type === "mode-switch");
  const lastModeSwitch = modeEvents[modeEvents.length - 1];
  const baselineEvents = versionHistory.filter((event) => event.type === "baseline");
  const lastBaselineEvent = baselineEvents[baselineEvents.length - 1];
  const modeBadgeTitle = `${activeMode === "planning"
    ? "Planning mode: durations, dates, dependencies and margin % are re-planning. The reserve is sized from the percentage and nothing is consumed. Emphasised columns: Duration, Predecessors, Margin %, Float."
    : "Monitoring mode: duration, start and progress edits track reality and consume the reserve; margin % is fixed. Emphasised columns: % complete, Margin consumed, Margin remaining, Variance."}${lastBaselineEvent ? ` Baseline captured on ${formatDate(lastBaselineEvent.at.slice(0, 10))}.` : ""}${lastModeSwitch ? ` Switched to Monitoring on ${formatDate(lastModeSwitch.at.slice(0, 10))}.` : ""}`;

  return (
    <div className="planner-shell" onClick={() => { setShowMenu(null); setViewOpen(false); setOverflowOpen(false); setBaselineOpen(false); setBaselineManageOpen(false); setModeMenuOpen(false); }}>
      <AppBar
        activeKey="planner"
        searchValue={query}
        onSearchChange={applySearch}
        onSearchKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setProjectHighlight((index) => Math.min(projectResults.length - 1, index + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setProjectHighlight((index) => Math.max(0, index - 1)); }
          if (event.key === "Enter" && projectResults[projectHighlight]) { event.preventDefault(); selectProject(projectResults[projectHighlight].id); }
          if (event.key === "Escape") applySearch("");
        }}
      />

      <header className="planner-context-bar">
        <div className="context-left">
          <h1 className="planner-project-heading" title={activeProject.name}>{activeProject.name}</h1>
          <label className="context-field">
            <span className="context-field-label">Version</span>
            <select className="context-select" value={activeVersionId} aria-label="Plan version" onChange={(event) => { setHistory([]); setFuture([]); setActiveVersion(event.target.value); }}>
              {planVersions.filter((version) => version.projectId === activeProjectId).map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}
            </select>
          </label>
          <div className="toolbar-popover-wrap">
            <button
              className={`mode-badge ${activeMode}`}
              title={modeBadgeTitle}
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              onClick={(event) => { event.stopPropagation(); setModeMenuOpen((open) => !open); setBaselineOpen(false); setViewOpen(false); setOverflowOpen(false); }}
            >
              {activeMode === "planning" ? <PencilRuler size={13} /> : <Activity size={13} />}
              {activeMode === "planning" ? "Planning" : "Monitoring"}
            </button>
            {modeMenuOpen && (
              <div className="toolbar-popover mode-popover" onClick={(event) => event.stopPropagation()}>
                <div className="popover-heading"><b>{activeMode === "planning" ? "PLANNING MODE" : "MONITORING MODE"}</b><button onClick={() => setModeMenuOpen(false)}><X size={14} /></button></div>
                <p className="mode-popover-copy">{activeMode === "planning"
                  ? "Durations, dates, dependencies and margin % are re-planning. The reserve is sized from the percentage and nothing is consumed."
                  : "Duration, start and progress edits track reality and consume the reserve; margin % is fixed."}</p>
                {activeMode === "planning" && (versionHasBaseline
                  ? <button className="tool-button" onClick={switchToMonitoring}><Activity size={14} /> Switch to Monitoring</button>
                  : <p className="mode-popover-copy mode-popover-locked">Monitoring is locked until a baseline is captured.</p>)}
              </div>
            )}
          </div>
        </div>

        <div className="context-center">
          <div className="toolbar-popover-wrap">
            <button
              className="baseline-trigger"
              title="Baseline for this project — capture, compare or manage saved baselines"
              aria-haspopup="menu"
              aria-expanded={baselineOpen}
              onClick={(event) => { event.stopPropagation(); setBaselineError(null); setBaselineOpen((open) => !open); setBaselineManageOpen(false); setModeMenuOpen(false); setViewOpen(false); setOverflowOpen(false); }}
            >
              <Layers size={14} />
              <span className="context-field-label">Baseline</span>
              <b className="baseline-trigger-name">{activeBaseline ? activeBaseline.name : "Geen baseline"}</b>
              <ChevronDown size={13} />
            </button>
            {baselineOpen && (
              <div className="toolbar-popover baseline-popover" onClick={(event) => event.stopPropagation()}>
                <div className="popover-heading"><b>BASELINE</b><button onClick={() => setBaselineOpen(false)}><X size={14} /></button></div>
                {baselineError && <p className="baseline-error" role="alert"><TriangleAlert size={13} /> {baselineError}</p>}
                <label><input type="checkbox" checked={showBaselineBars} onChange={(event) => setShowBaselineBars(event.target.checked)} /> Vergelijk met baseline</label>
                <div className="popover-subheading">ACTIEVE BASELINE</div>
                <div className="baseline-choices">
                  <button className={`baseline-choice${activeBaselineId ? "" : " current"}`} onClick={() => setActiveBaselineId("")}>Geen baseline</button>
                  {projectBaselines.map((baseline) => (
                    <button
                      key={baseline.id}
                      className={`baseline-choice${baseline.id === activeBaselineId ? " current" : ""}`}
                      title={`${baseline.name} · ${formatFullDate(baselineDateOf(baseline))}`}
                      onClick={() => setActiveBaselineId(baseline.id)}
                    >{baseline.name}</button>
                  ))}
                </div>
                <div className="baseline-actions">
                  <button className="tool-button" onClick={openBaseline}><FileSpreadsheet size={14} /> Baseline vastleggen</button>
                  <button className="tool-button" aria-expanded={baselineManageOpen} onClick={() => setBaselineManageOpen((open) => !open)}><Layers size={14} /> Baselines beheren ({projectBaselines.length})</button>
                </div>
                {baselineManageOpen && (
                  <div className="baseline-manage">
                    {projectBaselines.length === 0 && <p className="baseline-empty">Nog geen baseline vastgelegd voor {activeProject.name}.</p>}
                    {projectBaselines.map((baseline) => {
                      const version = planVersions.find((item) => item.id === baseline.versionId);
                      const isCompared = baseline.id === activeBaselineId;
                      return (
                        <div className={`baseline-row${isCompared ? " current" : ""}`} key={baseline.id}>
                          <div className="baseline-row-copy">
                            <b>{baseline.name}</b>
                            <small>{formatFullDate(baselineDateOf(baseline))} · {version?.name ?? "unknown version"}{isCompared ? " · compared" : ""}</small>
                          </div>
                          <button
                            className="baseline-delete"
                            title={`Delete ${baseline.name}`}
                            aria-label={`Delete baseline ${baseline.name}`}
                            onClick={() => requestDeleteBaseline(baseline)}
                          ><Trash2 size={14} /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="context-right">
          {projectOverloadInfo.resourceIds.length > 0 && (
            <button
              className="context-overload"
              onClick={openProjectCapacity}
              aria-label={`${projectOverloadInfo.resourceIds.length} medewerker${projectOverloadInfo.resourceIds.length === 1 ? "" : "s"} overbelast — open de capaciteit`}
              title={`${projectOverloadInfo.resourceIds.length} medewerker${projectOverloadInfo.resourceIds.length === 1 ? " is" : "s zijn"} van ${activeProject.name} overbelast in minstens één week. Klik om de capaciteit te openen.\n${overloadTooltip(projectOverloadInfo.weeks).join("\n")}`}
            >
              <TriangleAlert size={13} />
              {projectOverloadInfo.resourceIds.length === 1 ? "1 medewerker overbelast" : `${projectOverloadInfo.resourceIds.length} medewerkers overbelast`}
            </button>
          )}
          <button className="context-margin" onClick={openMarginReport} title={`Planned ${marginTotals.planned} d · consumed ${marginTotals.consumed} d · remaining ${marginTotals.remaining} d for this plan version — leaf tasks only, exactly what the margin report shows`}>
            Marge <b>{marginTotals.planned} d</b><span className="context-margin-seg"> · <b>{marginTotals.consumed} d</b> verbruikt</span><span className="context-margin-seg"> · <b>{marginTotals.remaining} d</b> over</span>
          </button>
        </div>
      </header>

      <div className="project-toolbar action-toolbar" onClick={(event) => event.stopPropagation()}>
        <div className="toolbar-left task-actions">
          <button className="tool-button primary" onClick={() => addTask()}><Plus size={16} /> New task</button>
          <span className="toolbar-divider" />
          <button className="icon-button" title="Indent (Tab)" aria-label="Indent (Tab)" disabled={!selected.length} onClick={() => selected[0] && indent(selected[0])}><IndentIncrease size={16} /></button>
          <button className="icon-button" title="Outdent (Shift+Tab)" aria-label="Outdent (Shift+Tab)" disabled={!selected.length} onClick={() => selected[0] && indent(selected[0], true)}><IndentDecrease size={16} /></button>
          <button className="icon-button" title="Delete (Delete)" aria-label="Delete (Delete)" disabled={!selected.length} onClick={deleteSelected}><Trash2 size={15} /></button>
          <span className="toolbar-divider" />
          <button className="icon-button" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled={!history.length} onClick={undo}><Undo2 size={15} /></button>
          <button className="icon-button" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled={!future.length} onClick={redo}><Redo2 size={15} /></button>
        </div>
        <div className="toolbar-right view-actions">
          <div className="toolbar-zoom segmented" role="group" aria-label="Zoom">
            {(["day", "week", "month", "quarter"] as const).map((value) => <button key={value} className={zoom === value ? "segment active" : "segment"} aria-pressed={zoom === value} onClick={() => setZoom(value)}>{value}</button>)}
          </div>
          <div className="toolbar-popover-wrap"><button className="tool-button quiet" onClick={() => { setViewOpen((open) => !open); setOverflowOpen(false); }}><Eye size={15} /> View</button>{viewOpen && <div className="toolbar-popover view-popover" onClick={(event) => event.stopPropagation()}>
            <div className="popover-heading"><b>VIEW</b><button onClick={() => setViewOpen(false)}><X size={14} /></button></div>
            <label><input type="checkbox" checked={showCriticalPath} onChange={(event) => setShowCriticalPath(event.target.checked)} /> Critical path</label>
            <label><input type="checkbox" checked={showMarginsOnBars} onChange={(event) => setShowMarginsOnBars(event.target.checked)} /> Margin zones</label>
            <label><input type="checkbox" checked={showLeave} onChange={(event) => setShowLeave(event.target.checked)} /> Leave on bars</label>
            <label><input type="checkbox" checked={showAvailability} onChange={(event) => setShowAvailability(event.target.checked)} /> Beschikbaarheid column</label>
            <div className="popover-subheading">COLUMNS</div>
            {(["totalFloat", "margin", "marginOriginal", "marginConsumed", "marginRemaining", "actualStart", "actualFinish", "predecessors", "resource"] as ColumnKey[]).map((key) => { const column = columnDefs.find((item) => item.key === key)!; return <label key={key}><input type="checkbox" checked={!hidden.includes(key)} onChange={() => setHidden((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} /> {column.label}</label>; })}
          </div>}</div>
          <select className="toolbar-zoom-select" value={zoom} onChange={(event) => setZoom(event.target.value as "day" | "week" | "month" | "quarter")} aria-label="Zoom"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option></select>
          <div className="toolbar-popover-wrap"><button className="icon-button" title="More actions" aria-label="More actions" onClick={() => { setOverflowOpen((open) => !open); setViewOpen(false); }}><MoreHorizontal size={18} /></button>{overflowOpen && <div className="toolbar-popover overflow-popover" onClick={(event) => event.stopPropagation()}>
            <div className="responsive-task-actions"><button disabled={!selected.length} onClick={() => selected[0] && indent(selected[0])}><IndentIncrease size={14} /> <span>Indent</span></button><button disabled={!selected.length} onClick={() => selected[0] && indent(selected[0], true)}><IndentDecrease size={14} /> <span>Outdent</span></button><button disabled={!selected.length} onClick={deleteSelected}><Trash2 size={14} /> Delete</button><button disabled={!history.length} onClick={undo}><Undo2 size={14} /> Undo</button><button disabled={!future.length} onClick={redo}><Redo2 size={14} /> Redo</button><div className="menu-rule" /></div>
            <button onClick={openRecalculate}><RefreshCw size={14} /> Recalculate</button>
            <button onClick={() => toast("Export ready")}><Download size={14} /> Export</button>
            <button onClick={openMarginReport}><Columns3 size={14} /> Margin report</button>
            <button onClick={() => toast("You are viewing your team dashboard")}><UserRound size={14} /> My dashboard</button>
            <button onClick={openProjectSettings}><CalendarDays size={14} /> Project calendar</button>
            <button onClick={openReplan}><RotateCcw size={14} /> Replan</button>
            <button onClick={openNewVersion}><Copy size={14} /> New version</button>
            <button onClick={openOptimizeSettings}><Sparkles size={14} /> Optimize planning</button>
            <div className="menu-rule" />
            <button onClick={openBaseline}><FileSpreadsheet size={14} /> Set baseline</button>
            <button onClick={openSaveTemplate}><Copy size={14} /> Save as template</button>
            {activeBaselineId && <button className="danger" onClick={() => { const active = baselines.find((baseline) => baseline.id === activeBaselineId); if (active) requestDeleteBaseline(active); }}><Trash2 size={14} /> Delete baseline</button>}
          </div>}</div>
        </div>
      </div>

      {recalcDialog && (
        <div className="modal-backdrop" onClick={() => setRecalcDialog(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">RECALCULATE PLANNING</div><h2>Recalculate the schedule</h2></div>
              <button className="icon-button" onClick={() => setRecalcDialog(false)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              Pick a planning direction and the reference date for this recalculation. The reference date is only used
              while recalculating — afterwards you can keep moving bars and they stay where you put them.
            </p>
            <div className="planning-mode">
              <span>Planning direction</span>
              <div>
                {(["forward", "backward"] as const).map((direction) => (
                  <button key={direction} className={recalcDirection === direction ? "selected" : ""} onClick={() => choosePlanningDirection(direction)}>
                    {direction === "forward" ? "Forward planning" : "Backward planning"}
                  </button>
                ))}
              </div>
            </div>
            <div className="planning-anchor">
              <span className="planning-anchor-label">{recalcDirection === "forward" ? "Reference start date" : "Reference finish date"}</span>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="planning-date-trigger">
                    <span>{formatDate(recalcDate)}</span>
                    <CalendarDays size={16} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="planning-calendar-popover">
                  <Calendar mode="single" selected={new Date(`${recalcDate}T12:00:00`)} onSelect={(date) => { if (date) setRecalcDate(dateLabel(date)); }} initialFocus />
                </PopoverContent>
              </Popover>
              <p>
                {recalcDirection === "forward"
                  ? `Every task is planned forward in working days from ${formatDate(recalcDate)} on the ${calendarName} calendar.`
                  : `Every task is planned backward in working days from ${formatDate(recalcDate)} on the ${calendarName} calendar.`}
              </p>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setRecalcDialog(false)}>Cancel</button>
              <button
                className="tool-button primary"
                onClick={() => {
                  recalculate(tasks, recalcDirection, true, recalcDate);
                  setPlanningDirection(recalcDirection);
                  setRecalcDialog(false);
                  toast.success(
                    recalcDirection === "forward"
                      ? `Schedule planned forward from ${formatDate(recalcDate)}`
                      : `Schedule planned backward from ${formatDate(recalcDate)}`,
                  );
                }}
              >
                Recalculate
              </button>
            </div>
          </div>
        </div>
      )}

      {versionDialog && (
        <div className="modal-backdrop" onClick={() => setVersionDialog(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">NEW VERSION</div><h2>Start a fresh plan</h2></div>
              <button className="icon-button" onClick={() => setVersionDialog(false)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              A new version is a copy of <b>{activePlanVersion?.name ?? "the current version"}</b>. It starts in
              Planning mode with consumed margin reset, and the version it was copied from is left untouched.
            </p>
            <div className="modal-grid">
              <label>
                Version name
                <input value={versionName} onChange={(event) => setVersionName(event.target.value)} />
              </label>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setVersionDialog(false)}>Cancel</button>
              <button className="tool-button primary" onClick={confirmNewVersion}>Create version</button>
            </div>
          </div>
        </div>
      )}

      {optimizeSettings && (
        <div className="modal-backdrop" onClick={cancelOptimizeSettings}>
          <div className="task-modal optimize-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">OPTIMIZE PLANNING</div><h2>Optimization settings</h2></div>
              <button className="icon-button" onClick={cancelOptimizeSettings} aria-label="Cancel"><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              The optimization lowers every employee&apos;s weekly occupancy in <b>{activeProject.name}</b> by moving tasks and by spreading
the same work hours over more working days (up to +50% duration). Tick the milestones that must keep exactly the date they have now:
a fixed milestone is never moved, and a task that would push it is left alone.
            </p>
            <div className="optimize-section">
              <h3>Milestones ({optimizeMilestoneChoices.length})</h3>
              {optimizeMilestoneChoices.length === 0 ? (
                <p className="optimize-empty">This project has no milestones.</p>
              ) : (
                <div className="optimize-milestone-list">
                  {optimizeMilestoneChoices.map((milestone) => {
                    const toggle = () => setOptimizeSettings((current) => (current ?? []).includes(milestone.taskId)
                      ? (current ?? []).filter((id) => id !== milestone.taskId)
                      : [...(current ?? []), milestone.taskId]);
                    return (
                      <label key={milestone.taskId} className={milestone.fixed ? "optimize-milestone is-fixed" : "optimize-milestone"}>
                        <input type="checkbox" checked={milestone.fixed} onChange={toggle} />
                        <span className="optimize-milestone-name">{milestone.name}</span>
                        <span className="optimize-milestone-date">{formatFullDate(milestone.date)}</span>
                        <span className="optimize-milestone-flag">Fixed date</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="optimize-hint">The selection is remembered for this project and pre-filled the next time.</p>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={cancelOptimizeSettings}>Cancel</button>
              <button className="tool-button primary" onClick={runOptimize}>Run optimization</button>
            </div>
          </div>
        </div>
      )}

      {(optimizePlan || optimizeError) && (
        <div className="modal-backdrop" onClick={cancelOptimize}>
          <div className="task-modal optimize-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">OPTIMIZE PLANNING</div><h2>Resource optimization preview</h2></div>
              <button className="icon-button" onClick={cancelOptimize} aria-label="Cancel"><X size={18} /></button>
            </div>
            {optimizeError || !optimizePlan ? (
              <>
                <p className="calendar-copy">{optimizeError}</p>
                <div className="modal-actions">
                  <button className="tool-button" onClick={cancelOptimize}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p className="calendar-copy">
                  Only <b>{activeProject.name}</b> may change. A task may move and may grow by at most 50% of the duration it had before
                  this run — never shorter, never split, and spreading a task over more days keeps exactly the same work hours. Resource
                  assignments and dependencies stay as they are, fixed milestones keep their date, and each employee&apos;s weekly occupancy
                  counts the work of all other projects. Target {Math.round(OCCUPANCY_TARGET * 100)}% per week, hard limit 100%.
                </p>

                <div className="optimize-summary">
                  <span>Project end</span>
                  <b>{formatFullDate(optimizePlan.oldProjectFinish)} → {formatFullDate(optimizePlan.newProjectFinish)}</b>
                  <span className={optimizePlan.finishDeltaWorkingDays === 0 ? "optimize-badge ok" : "optimize-badge up"}>
                    {optimizePlan.finishDeltaWorkingDays === 0
                      ? "unchanged"
                      : `${optimizePlan.finishDeltaWorkingDays > 0 ? "+" : ""}${optimizePlan.finishDeltaWorkingDays} working day${Math.abs(optimizePlan.finishDeltaWorkingDays) === 1 ? "" : "s"}`}
                  </span>
                  <span>{optimizePlan.movedCriticalTasks ? "Critical path tasks were moved." : "No critical path task was moved."}</span>
                </div>

                <div className="optimize-section">
                  <h3>Milestones ({optimizePlan.milestones.length})</h3>
                  {optimizePlan.milestones.length === 0 ? (
                    <p className="optimize-empty">This project has no milestones.</p>
                  ) : (
                    <div className="optimize-table-wrap">
                      <table className="optimize-table">
                        <thead>
                          <tr><th>Milestone</th><th>Old date</th><th>New date</th><th>Kept fixed</th></tr>
                        </thead>
                        <tbody>
                          {optimizePlan.milestones.map((milestone) => (
                            <tr key={milestone.taskId} className={milestone.fixed ? "optimize-fixed-row" : undefined}>
                              <td>{milestone.name}</td>
                              <td>{formatDate(milestone.oldDate)}</td>
                              <td>{milestone.moved ? formatDate(milestone.newDate) : "unchanged"}</td>
                              <td>{milestone.fixed ? "yes — fixed for this run" : milestone.moved ? "no — follows the plan" : "no"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="optimize-section">
                  <h3>Changed tasks ({optimizePlan.moves.length})</h3>
                  {optimizePlan.moves.length === 0 ? (
                    <p className="optimize-empty">No task needs to change — the plan already meets the target within its rules.</p>
                  ) : (
                    <>
                      <div className="optimize-table-wrap">
                        <table className="optimize-table">
                          <thead>
                            <tr><th>Task</th><th>Change</th><th>Old dates</th><th>New dates</th><th>Duration</th><th>Extension</th><th>Float used</th><th>Critical</th><th>Work hours</th></tr>
                          </thead>
                          <tbody>
                            {optimizePlan.moves.map((move) => (
                              <tr key={move.taskId}>
                                <td>{move.taskName}</td>
                                <td>{move.changeKind === "both" ? "moved and extended" : move.changeKind}</td>
                                <td>{formatDate(move.oldStart)} → {formatDate(move.oldFinish)}</td>
                                <td>{formatDate(move.newStart)} → {formatDate(move.newFinish)}</td>
                                <td>{move.newDuration === move.oldDuration ? `${move.oldDuration}` : `${move.oldDuration} → ${move.newDuration}`}</td>
                                <td>{move.extensionDays > 0 ? `+${move.extensionDays} (+${move.extensionPct}%)` : "—"}</td>
                                <td>{move.floatUsed > 0 ? `${move.floatUsed} d of ${move.floatAvailable} d` : move.shiftDays < 0 ? "moved earlier" : "—"}</td>
                                <td>{move.critical ? "yes" : "no"}</td>
                                <td>{move.extensionDays > 0 ? `${formatAvailableHours(move.newWork)} h, unchanged` : `${formatAvailableHours(move.newWork)} h`}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="optimize-hint">
                        {optimizePlan.workHoursPreserved
                          ? `Total work hours are unchanged: every extended task spreads exactly the same hours over more working days (${optimizePlan.moves.filter((move) => move.extensionDays > 0).length} extended).`
                          : "Warning: a task's total work hours differ from the original — the change is not applied as shown."}
                      </p>
                    </>
                  )}
                </div>

                <div className="optimize-section">
                  <h3>Weekly occupancy per employee (before → after)</h3>
                  {optimizePlan.occupancy.every((resource) => resource.weeks.every((week) => week.before <= 0 && week.after <= 0)) ? (
                    <p className="optimize-empty">No planned hours this period.</p>
                  ) : (
                    <div className="optimize-table-wrap">
                      <table className="optimize-table">
                        <thead>
                          <tr><th>Employee</th><th>Week</th><th>Available</th><th>Before</th><th>After</th></tr>
                        </thead>
                        <tbody>
                          {optimizePlan.occupancy.flatMap((resource) => resource.weeks
                            .filter((week) => week.before > 0 || week.after > 0)
                            .map((week) => (
                              <tr key={`${resource.resourceId}-${week.weekStart}`}>
                                <td>{resource.resourceName}</td>
                                <td>{formatFullDate(week.weekStart)}</td>
                                <td>{formatAvailableHours(week.available)} h</td>
                                <td>{formatAvailableHours(week.before)} h{week.available > 0 ? ` (${Math.round((week.before / week.available) * 100)}%)` : ""}</td>
                                <td className={week.available > 0 && week.after > week.available ? "negative" : undefined}>{formatAvailableHours(week.after)} h{week.available > 0 ? ` (${Math.round((week.after / week.available) * 100)}%)` : ""}</td>
                              </tr>
                            )))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {optimizePlan.blockers.length > 0 && (
                  <div className="optimize-section">
                    <h3>Warnings: fixed milestones and the +50% extension limit ({optimizePlan.blockers.length})</h3>
                    <div className="optimize-problems">
                      {optimizePlan.blockers.map((blocker, index) => (
                        <div key={`${blocker.kind}-${index}`} className="optimize-problem">
                          <b>{blocker.kind === "fixed-milestone" ? `Fixed milestone: ${blocker.milestoneName}` : "Extension limit reached"}</b>
                          <span>{blocker.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="optimize-section">
                  <h3>Remaining weeks above 100% or far from 90% ({optimizePlan.unresolved.length})</h3>
                  {optimizePlan.unresolved.length === 0 ? (
                    <p className="optimize-empty">Every booked week is at or below the hard limit and within a healthy distance of the target.</p>
                  ) : (
                    <div className="optimize-problems">
                      {optimizePlan.unresolved.map((problem) => (
                        <div key={`${problem.resourceId}-${problem.weekStart}-${problem.kind}`} className="optimize-problem">{problem.reason}</div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="modal-actions">
                  <button className="tool-button" onClick={cancelOptimize}>Cancel</button>
                  <button className="tool-button primary" onClick={applyOptimize}>Apply</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {templateDialog && (
        <div className="modal-backdrop" onClick={() => setTemplateDialog(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">SAVE AS TEMPLATE</div><h2>Reuse this plan</h2></div>
              <button className="icon-button" onClick={() => setTemplateDialog(false)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              Saves <b>{activePlanVersion?.name ?? "the active version"}</b> of {activeProject.name} as a reusable template
              that new projects can start from.
            </p>
            <div className="modal-grid">
              <label>
                Template name
                <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
              </label>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setTemplateDialog(false)}>Cancel</button>
              <button className="tool-button primary" onClick={confirmSaveTemplate} disabled={!templateName.trim()}>Save template</button>
            </div>
          </div>
        </div>
      )}

      {baselinePendingDelete && (
        <div className="modal-backdrop" onClick={closeDeleteBaseline}>
          <div className="task-modal baseline-delete-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <div className="eyebrow">DELETE BASELINE</div>
                <h2>Delete "{baselinePendingDelete.name}"?</h2>
              </div>
              <button className="icon-button" onClick={closeDeleteBaseline}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              Captured on {formatFullDate(baselineDateOf(baselinePendingDelete))} for{" "}
              {planVersions.find((version) => version.id === baselinePendingDelete.versionId)?.name ?? activePlanVersion?.name ?? "this version"}.
              The baseline and all of its stored task snapshots are removed for good and cannot be restored. Task dates,
              durations, margins, dependencies and the version&apos;s mode stay exactly as they are.
            </p>
            {baselinePendingDelete.id === activeBaselineId && (
              <div className="baseline-warning" role="alert">
                <TriangleAlert size={16} />
                <div>
                  <p>Let op: dit is de baseline waartegen deze versie wordt opgevolgd. Na verwijderen is er geen vergelijking met de oorspronkelijke planning meer mogelijk in deze versie.</p>
                  {deleteBaselineFallback
                    ? <p>De opvolging valt terug op baseline {deleteBaselineFallback.name} ({formatFullDate(baselineDateOf(deleteBaselineFallback))}).</p>
                    : <p>Er blijft geen baseline over in deze versie om tegen te vergelijken.</p>}
                </div>
              </div>
            )}
            {baselineError && <p className="baseline-error" role="alert"><TriangleAlert size={13} /> {baselineError}</p>}
            <div className="modal-actions">
              <button className="tool-button" onClick={closeDeleteBaseline}>Annuleren</button>
              <button className="tool-button primary baseline-delete-confirm" onClick={confirmDeleteBaseline}>Verwijderen</button>
            </div>
          </div>
        </div>
      )}

      {baselineDialog && (
        <div className="modal-backdrop" onClick={() => setBaselineDialog(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">SET BASELINE</div><h2>Capture this version</h2></div>
              <button className="icon-button" onClick={() => setBaselineDialog(false)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              A baseline freezes the current version exactly as it is — start, finish, duration, dependencies,
              margin % and margin in days — so Monitoring can measure against it. It cannot be changed afterwards.
            </p>
            <div className="modal-grid">
              <label>
                Baseline name
                <input value={baselineName} onChange={(event) => setBaselineName(event.target.value)} />
              </label>
              <label>
                Capture date
                <input type="date" value={baselineDate} onChange={(event) => setBaselineDate(event.target.value)} />
              </label>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setBaselineDialog(false)}>Cancel</button>
              <button className="tool-button primary" onClick={confirmBaseline}>Capture baseline</button>
            </div>
          </div>
        </div>
      )}

      {baselineSwitchPrompt && (
        <div className="modal-backdrop" onClick={() => setBaselineSwitchPrompt(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">BASELINE CAPTURED</div><h2>Switch to Monitoring mode now?</h2></div>
              <button className="icon-button" onClick={() => setBaselineSwitchPrompt(false)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              In Monitoring mode a duration edit means reality changed: it consumes the task's remaining margin
              before successors move, and margin % becomes read-only. Choose Later to keep planning — the toggle
              stays unlocked, so you can switch whenever you want.
            </p>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setBaselineSwitchPrompt(false)}>Later</button>
              <button className="tool-button primary" onClick={() => { setBaselineSwitchPrompt(false); switchToMonitoring(); }}>Yes, switch</button>
            </div>
          </div>
        </div>
      )}

      {replanDialog && (
        <div className="modal-backdrop" onClick={() => setReplanDialog(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">REPLAN FROM TODAY</div><h2>Build in fresh reserve</h2></div>
              <button className="icon-button" onClick={() => setReplanDialog(false)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              The current version of <b>{activeProject.name}</b> is kept exactly as it is; the replan becomes a new plan
              version, so every replan stays in the history. Started and completed work is never re-planned.
            </p>
            <div className="modal-grid">
              <label>
                New version name
                <input value={replanName} onChange={(event) => setReplanName(event.target.value)} />
              </label>
              <label>
                New margin %
                <input type="number" min={0} max={100} value={replanPct} onChange={(event) => setReplanPct(event.target.value)} />
              </label>
            </div>
            <div className="planning-mode">
              <span>Apply the new margin to</span>
              <div>
                {([
                  ["not-started", "Not started"],
                  ["all", "All tasks"],
                  ["selected", "Selected tasks"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className={replanScope === value ? "selected" : ""}
                    disabled={value === "selected" && !selected.length}
                    onClick={() => setReplanScope(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="replan-summary">
              <span><b>{replanPreview?.affected ?? 0}</b> task{(replanPreview?.affected ?? 0) === 1 ? "" : "s"} affected</span>
              <span>Finish <b>{formatDate(replanPreview?.finish || projectFinishIso)}</b><small>current version: {formatDate(projectFinishIso)}</small></span>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setReplanDialog(false)}>Cancel</button>
              <button className="tool-button primary" onClick={confirmReplan} disabled={replanScope === "selected" && !selected.length}>Create replan</button>
            </div>
          </div>
        </div>
      )}

      {projectDialog && (
        <div className="modal-backdrop" onClick={() => setProjectDialog(false)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">PROJECT SETTINGS</div><h2>{activeProject.name}</h2></div>
              <button className="icon-button" onClick={() => setProjectDialog(false)}><X size={18} /></button>
            </div>
            <div className="modal-grid">
              <label>
                Calendar
                <select value={pendingCalendarId} onChange={(event) => setPendingCalendarId(event.target.value)}>
                  {system.calendars.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.name} · {CALENDAR_TYPE_LABELS[calendar.type]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="calendar-copy">
              Every project is planned on one calendar. Working days, holidays and shutdowns are resolved from it, and
              changing it reschedules this project immediately.{" "}
              <button className="link-button" onClick={() => navigate("/calendars")}>Manage calendars →</button>
            </p>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setProjectDialog(false)}>Cancel</button>
              <button className="tool-button primary" onClick={requestCalendarChange}>Save</button>
            </div>
          </div>
        </div>
      )}

      {relinkConfirm && (
        <div className="modal-backdrop" onClick={() => setRelinkConfirm(null)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">CONFIRM RECALCULATION</div><h2>Change the project calendar?</h2></div>
              <button className="icon-button" onClick={() => setRelinkConfirm(null)}><X size={18} /></button>
            </div>
            <p className="calendar-copy">
              This affects <b>{relinkConfirm.projects}</b> project{relinkConfirm.projects === 1 ? "" : "s"} and will move{" "}
              <b>{relinkConfirm.tasks}</b> task{relinkConfirm.tasks === 1 ? "" : "s"}.
            </p>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setRelinkConfirm(null)}>Cancel</button>
              <button
                className="tool-button primary"
                onClick={() => {
                  setProjectCalendar(activeProject.id, relinkConfirm.calendarId);
                  setRelinkConfirm(null);
                  toast.success("Project calendar updated");
                }}
              >
                Apply and recalculate
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`planner-body ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
        <aside className={`project-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <button className="sidebar-toggle" title={sidebarCollapsed ? "Show projects (Ctrl/Cmd+B)" : "Hide projects (Ctrl/Cmd+B)"} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>{sidebarCollapsed ? "›" : "‹"}</button>
          {!sidebarCollapsed && <>
            <div className="sidebar-projects">
              {(["active", "archived"] as const).map((group) => { const list = filteredProjectGroups[group]; const expanded = expandedGroups[group]; return <div className="sidebar-group" key={group}><button className="sidebar-group-header" onClick={() => setExpandedGroups((current) => ({ ...current, [group]: !current[group] }))}><span>{expanded ? "⌄" : "›"} {group === "active" ? "Active" : "Archived"} <small>{list.length}</small></span></button>{expanded && <div className="sidebar-project-list">{list.map((project, index) => { const projectTaskList = projectTasks(project.id); const first = projectTaskList[0]; const finish = projectTaskList.length ? projectTaskList.reduce((latest, task) => task.finish > latest ? task.finish : latest, first.finish) : project.startDate; return <button key={project.id} title={project.name} className={`sidebar-project ${project.id === activeProjectId ? "current" : ""} ${index === projectHighlight && projectSearch ? "highlighted" : ""}`} onClick={() => selectProject(project.id)}><b>{project.name}</b><small>{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${project.startDate}T12:00:00`))} - {new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${finish}T12:00:00`))} · {projectTaskList.length} tasks</small></button>; })}{!list.length && <span className="sidebar-empty">No projects match</span>}</div>}</div>; })}
              {!filteredProjectGroups.active.length && !filteredProjectGroups.archived.length && <div className="sidebar-no-results">No projects match<button onClick={() => applySearch("")}>Clear search</button></div>}
            </div>
            <div className="sidebar-actions"><button className="tool-button primary" onClick={() => navigate("/projects?new=1")}><Plus size={14} /> New project</button><button className="sidebar-all-projects" onClick={() => navigate("/projects")}>All projects →</button></div>
          </>}
        </aside>
        <div className="workbench">
        <section className="grid-pane" style={{ width: `${split}%` }}>
          <div className="grid-scroll" ref={scrollRef}>
            <div className="grid-header">
              {columnDefs
                .filter((column) => column.key === "id" || (column.key === "availability" ? showAvailability : !hidden.includes(column.key)) || (activeBaselineId && ["baselineStart", "baselineFinish", "variance"].includes(column.key)))
                .map((column) => (
                  <div
                    key={column.key}
                    className={`grid-head-cell ${column.key === "totalFloat" ? "float-head" : ""} ${modeEmphasis[activeMode].includes(column.key) ? "mode-emphasis" : ""}`}
                    style={{ width: column.width }}
                    role={column.key === "totalFloat" || column.key === "work" ? "button" : undefined}
                    aria-sort={sort?.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                    title={column.key === "totalFloat" ? "Float: click to sort the tightest tasks first" : column.key === "work" ? "Work: click to sort by total hours" : undefined}
                    onClick={column.key === "totalFloat" ? toggleFloatSort : column.key === "work" ? toggleWorkSort : undefined}
                    onContextMenu={(event) => { event.preventDefault(); toast(`${column.label}: column options ready`); }}
                  >
                    {column.label}
                    {sort?.key === column.key
                      ? (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                      : <ChevronsUpDown size={12} />}
                  </div>
                ))}
            </div>
            {visibleTasks.map((task) => {
              const depth = (() => {
                let count = 0;
                let current = task;
                while (current.parentId) {
                  count++;
                  current = taskById.get(current.parentId) ?? current;
                }
                return count;
              })();
              const summary = tasks.some((item) => item.parentId === task.id);
              const displayTask = taskById.get(task.id) ?? task;
              return (
                <div
                  key={task.id}
                  className={`grid-row ${selected.includes(task.id) ? "selected" : ""}`}
                  style={{ height: rowHeight }}
                  onClick={(event) => setSelected(event.shiftKey || event.ctrlKey ? [...new Set([...selected, task.id])] : [task.id])}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelected([task.id]);
                    setShowMenu({ x: event.clientX, y: event.clientY, id: task.id });
                  }}
                  draggable
                  onDragStart={() => setDragging(task.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragging && dragging !== task.id) {
                      commit(tasks.map((item) => (item.id === dragging ? { ...item, parentId: task.id } : item)));
                      toast("Task nested under " + task.name);
                    }
                    setDragging(null);
                  }}
                >
                  {columnDefs
                    .filter((column) => column.key === "id" || (column.key === "availability" ? showAvailability : !hidden.includes(column.key)) || (activeBaselineId && ["baselineStart", "baselineFinish", "variance"].includes(column.key)))
                    .map((column) => {
                      const value =
                        column.key === "id"
                          ? String(taskDisplayIds.get(task.id) ?? "")
                          : column.key === "predecessors"
                            ? formatPredecessorsForDisplay(task.predecessors, calculatedTasks, taskDisplayIds)
                          : column.key === "wbs"
                            ? getWbs(task, tasks)
                            : column.key === "duration"
                              ? `${displayTask.duration} ${displayTask.durationUnit === "days" ? "d" : "w"}`
                              : column.key === "work"
                                ? (isMilestone(task) ? "—" : `${displayTask.work ?? 0} h`)
                              : column.key === "distribution"
                                ? (summary || isMilestone(task) ? "—" : (DISTRIBUTION_OPTIONS.find((option) => option.value === normalizeDistribution(displayTask.distribution))?.label ?? "—"))
                              : column.key === "percent"
                                ? `${displayTask.percent}%`
                                : column.key === "actualStart"
                                  ? (displayTask.actualStart ?? "")
                                  : column.key === "actualFinish"
                                    ? (displayTask.actualFinish ?? "")
                                : column.key === "margin"
                                  ? `${displayTask.marginPct ?? 0}%`
                                  : column.key === "totalFloat"
                                    ? (summary ? "" : (() => {
                                        const floatText = `${displayTask.totalFloat ?? 0} d`;
                                        const baselineSnapshot = activeBaselineSnapshots.get(task.id);
                                        if (activeMode !== "monitoring" || !baselineSnapshot || baselineSnapshot.totalFloat === undefined) return floatText;
                                        const floatDelta = (displayTask.totalFloat ?? 0) - baselineSnapshot.totalFloat;
                                        return `${floatText} (${floatDelta >= 0 ? "+" : ""}${floatDelta})`;
                                      })())
                                    : column.key === "marginOriginal"
                                      ? `${displayTask.marginDaysOriginal ?? 0} d`
                                      : column.key === "marginConsumed"
                                        ? `${displayTask.marginDaysConsumed ?? 0} d`
                                        : column.key === "marginRemaining"
                                          ? `${Math.max(0, (displayTask.marginDaysOriginal ?? 0) - (displayTask.marginDaysConsumed ?? 0))} d`
                                    : column.key === "baselineStart"
                                      ? activeBaselineSnapshots.get(task.id)?.startDate ?? "—"
                                      : column.key === "baselineFinish"
                                        ? activeBaselineSnapshots.get(task.id)?.finishDate ?? "—"
                                        : column.key === "variance"
                                          ? (() => {
                                              const snapshot = activeBaselineSnapshots.get(task.id);
                                              if (!snapshot) return "—";
                                              const days = displayTask.finish === snapshot.finishDate
                                                ? 0
                                                : displayTask.finish > snapshot.finishDate
                                                  ? workingDaysBetween(snapshot.finishDate, displayTask.finish, calendarId, system) - 1
                                                  : -(workingDaysBetween(displayTask.finish, snapshot.finishDate, calendarId, system) - 1);
                                              // Workload deviation in hours sits beside the date deviation.
                                              const workDelta = snapshot.work === undefined ? null : (displayTask.work ?? 0) - snapshot.work;
                                              return `${days >= 0 ? "+" : ""}${days} d${workDelta === null ? "" : ` · ${workDelta >= 0 ? "+" : ""}${displayHours(workDelta)} h`}`;
                                            })()
                                    : column.key === "resource"
                                  ? assignedResources(task.id).map((resource) => resource?.name).join(", ")
                                  : column.key === "availability"
                                    ? `${formatAvailableHours(leaveInfo.get(task.id)?.availableHours ?? 0)} h`
                                  : String((task as unknown as Record<string, unknown>)[column.key] ?? "");
                      const isName = column.key === "name";
                      const modeLock = fieldModeReadOnly(column.key, activeMode);
                      const milestone = isMilestone(task);
                      // An adjusted task's segments and dates belong together: its split,
                      // dates and summed workload can only change through a new adjustment.
                      const adjustLocked = hasAllocationSegments(task) && ["start", "finish", "duration", "work", "distribution"].includes(column.key);
                      const structuralLock = ["id", "wbs", "availability", "totalFloat", "marginOriginal", "marginConsumed", "marginRemaining", "baselineStart", "baselineFinish", "variance"].includes(column.key) || (summary && ["start", "finish", "duration", "margin", "work"].includes(column.key)) || (milestone && column.key === "work") || adjustLocked || ((summary || milestone) && column.key === "distribution");
                      const canEdit = !structuralLock && !modeLock;
                      const readOnlyReason = modeLock ?? (adjustLocked ? (column.key === "work" ? "Total workload is fixed after an adjustment: the sum of the fixed and the re-planned hours." : "Fixed after an adjustment — use Adjust remaining work, or Edit / Remove it in the task panel.") : milestone && column.key === "work" ? "Milestones have no work." : summary ? "Summary rows roll up their children." : structuralLock ? "Calculated column — not editable." : undefined);
                      return (
                        <div
                          key={column.key}
                          className={`grid-cell ${modeEmphasis[activeMode].includes(column.key) ? "mode-emphasis" : ""} ${isName ? "name-cell" : ""} ${column.key === "resource" ? "resource-cell" : ""} ${column.key === "totalFloat" ? "float-cell" : ""} ${column.key === "margin" ? "margin-cell" : ""} ${marginNotice?.taskId === task.id && column.key === "margin" ? "has-notice" : ""} ${absorptionNotice?.taskId === task.id && absorptionColumns.includes(column.key) ? "has-notice" : ""} ${column.key === "totalFloat" && !summary && (displayTask.totalFloat ?? 0) === 0 ? "critical-float" : ""} ${cellError?.taskId === task.id && cellError.column === column.key ? "cell-invalid" : ""} ${!canEdit ? "readonly" : ""}`}
                          style={{ width: column.width }}
                          title={readOnlyReason}
                          onClick={() => {
                            if (canEdit && (column.key === "start" || column.key === "finish")) {
                              setEditing({ id: task.id, field: column.key });
                              setDraft(value);
                            }
                          }}
                          onDoubleClick={() => {
                            if (canEdit) {
                              setEditing({ id: task.id, field: column.key });
                              setDraft(value);
                            }
                          }}
                        >
                          {cellError?.taskId === task.id && cellError.column === column.key && <span className="cell-validation-error" role="alert">{cellError.message}</span>}
                          {marginNotice?.taskId === task.id && column.key === "margin" && <span className="cell-margin-notice" role="status">{marginNotice.message}</span>}
                          {absorptionNotice?.taskId === task.id && absorptionColumns.includes(column.key) && <span className="cell-margin-notice" role="status">{absorptionNotice.message}</span>}
                          {isName && <span className="row-handle"><GripVertical size={13} /></span>}
                          {isName && summary && (
                            <button className="collapse-button" onClick={(event) => { event.stopPropagation(); toggleCollapse(task.id); }}>
                              {task.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            </button>
                          )}
                          {isName && !summary && <span className="task-spacer" />}
                          {isName && !summary && (() => {
                            const stale = fixedDaysOnNonWorkingDays(displayTask, system, calendarId);
                            return stale.length ? <span className="fixed-day-warning" title={`Fixed hours stay on ${stale.join(", ")}, which are no longer working days. The hours are not moved.`}><TriangleAlert size={12} /></span> : null;
                          })()}
                          {column.key === "distribution" && canEdit ? (
                            <select
                              className="cell-select"
                              value={normalizeDistribution(displayTask.distribution)}
                              onClick={(event) => event.stopPropagation()}
                              onMouseDown={(event) => event.stopPropagation()}
                              onChange={(event) => updateTask(task.id, "distribution", event.target.value)}
                            >
                              {DISTRIBUTION_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          ) : column.key === "resource" ? (() => {
                            const selectedResourceIds = assignments.filter((assignment) => assignment.taskId === task.id).map((assignment) => assignment.resourceId);
                            const selectedResources = selectedResourceIds.map((id) => resources.find((resource) => resource.id === id)).filter(Boolean);
                            const resourceQuery = resourceEditor?.taskId === task.id ? resourceEditor.query : "";
                            const suggestions = resources.filter((resource) =>
                              (resource.isActive || selectedResourceIds.includes(resource.id)) &&
                              !selectedResourceIds.includes(resource.id) &&
                              resource.name.toLowerCase().includes(resourceQuery.toLowerCase()),
                            );
                            const selectResource = (resourceId: string) => {
                              setTaskAssignments(task.id, [...selectedResourceIds, resourceId]);
                              setResourceEditor({ taskId: task.id, query: "" });
                            };
                            const removeResource = (resourceId: string) => setTaskAssignments(task.id, selectedResourceIds.filter((id) => id !== resourceId));
                            return <div className={`resource-combobox ${resourceEditor?.taskId === task.id ? "open" : ""}`} onClick={(event) => event.stopPropagation()}>
                              <div className="resource-combobox-input" onClick={() => setResourceEditor({ taskId: task.id, query: "" })}>
                                {selectedResources.map((resource) => resource && <span className="resource-chip" key={resource.id} style={{ borderColor: resource.colour }}>
                                  <span className="resource-chip-dot" style={{ background: resource.colour }} />{resource.name}<button type="button" onClick={() => removeResource(resource.id)}><X size={10} /></button>
                                </span>)}
                                <input
                                  autoFocus={resourceEditor?.taskId === task.id}
                                  value={resourceQuery}
                                  placeholder={selectedResources.length ? "Add…" : "Assign resource…"}
                                  onFocus={() => setResourceEditor({ taskId: task.id, query: resourceQuery })}
                                  onChange={(event) => setResourceEditor({ taskId: task.id, query: event.target.value })}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && suggestions[0]) { event.preventDefault(); selectResource(suggestions[0].id); }
                                    if (event.key === "Escape") setResourceEditor(null);
                                    if (event.key === "Backspace" && !resourceQuery && selectedResourceIds.length) removeResource(selectedResourceIds[selectedResourceIds.length - 1]);
                                  }}
                                />
                              </div>
                              {resourceEditor?.taskId === task.id && <div className="resource-suggestions">
                                {suggestions.length ? suggestions.map((resource) => <button type="button" key={resource.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectResource(resource.id)}><span className="resource-suggestion-dot" style={{ background: resource.colour }} /><span><b>{resource.name}</b><small>{resource.role || "Employee"}</small></span></button>) : <span className="resource-no-results">No active employees match “{resourceQuery}”</span>}
                              </div>}
                            </div>;
                          })() : editing?.id === task.id && editing.field === column.key ? (
                            <input
                              autoFocus
                              className="cell-input"
                              type={["start", "finish", "actualStart", "actualFinish"].includes(column.key) ? "date" : "text"}
                              value={draft}
                              placeholder={isName && task.id === namingTaskId ? "New task" : undefined}
                              onChange={(event) => setDraft(event.target.value)}
                              onFocus={(event) => { if (isName && task.id !== namingTaskId && (task.name === "New task" || task.name === "Nieuwe taak")) event.currentTarget.select(); }}
                              onKeyDown={(event) => handleKey(event, task, column.key)}
                              /* Only save when this cell is still the one being edited, so the blur
                                 that follows Enter (or Escape) cannot commit a stale value. */
                              onBlur={() => { if (editing?.id === task.id && editing.field === column.key) updateTask(task.id, column.key, draft); }}
                            />
                          ) : (
                            <span style={isName ? { paddingLeft: depth * 17 } : undefined} className={isName && summary ? "summary-name" : ""}>
                              {value}
                            </span>
                          )}
                          {column.key === "resource" && (() => {
                            const overload = taskOverload.get(task.id);
                            if (!overload || !overload.count) return null;
                            const leaf = !summary;
                            // A leaf names each problem week; a summary only counts the
                            // descendants that carry the flag, never a check of its own.
                            const label = leaf
                              ? overloadTooltip(overload.weeks).join("\n")
                              : `${overload.count} subtask${overload.count === 1 ? "" : "s"} met een overbelaste resource.`;
                            return (
                              <button
                                type="button"
                                className="cell-overload-flag"
                                title={label}
                                aria-label={leaf ? "Overbelaste resource — open de capaciteit" : `${overload.count} subtaken met een overbelaste resource`}
                                onClick={(event) => { event.stopPropagation(); openResourceCapacity(overload.weeks); }}
                              >
                                <TriangleAlert size={12} />
                                {!leaf && <span className="cell-overload-count">{overload.count}</span>}
                              </button>
                            );
                          })()}
                          {column.key === "resource" && (() => {
                            const entries = overloadIndex.unavailableByTask.get(task.id);
                            if (!entries || !entries.length) return null;
                            const messages = entries.map((entry) => unavailableWarning(entry.resourceName, entry.work));
                            return <span className="cell-unavailable-notice" role="alert" title={messages.join("\n")}>{messages.join(" ")}</span>;
                          })()}
                          {column.key === "resource" && (() => {
                            const info = leaveInfo.get(task.id);
                            if (overloadIndex.unavailableByTask.get(task.id)?.length) return null;
                            if (!info || info.leaveDays <= 0) return null;
                            const labels = leaveLabels(info);
                            return <span className="cell-leave-days" title={`${info.leaveDays} leave day${info.leaveDays === 1 ? "" : "s"} of the assigned resource fall inside this task${labels.length ? ` (${labels.join(", ")})` : ""}. Leave never moves dates.`}>{info.leaveDays} d leave</span>;
                          })()}
                          {column.key === "start" && task.startConstraint && (
                            <button
                              type="button"
                              className={`constraint-flag ${task.startConstraintActive ? "active" : "inactive"}`}
                              title={task.startConstraintActive
                                ? `Start no earlier than ${formatDate(task.startConstraint)} — click to remove constraint.`
                                : `Constraint ${formatDate(task.startConstraint)} is inactive: a predecessor now sets the start. Click to remove.`}
                              onClick={(event) => { event.stopPropagation(); removeConstraint(task.id); }}
                            >⚑</button>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        </section>

        <div
          className="splitter"
          onPointerDown={(event) => {
            const start = event.clientX;
            const original = split;
            const move = (moveEvent: PointerEvent) =>
              setSplit(Math.max(35, Math.min(72, original + ((moveEvent.clientX - start) / window.innerWidth) * 100)));
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          <span />
        </div>

        <section className="timeline-pane">
          <div className="timeline-scroll">
            <div className="timeline-header" style={{ width: timelineWidth }}>
              <div className="month-row">
                {timelineDays
                  .filter((day) => day.getDate() === 1 || day.getTime() === timelineStart.getTime())
                  .map((day) => (
                    <span key={day.toISOString()} style={{ left: dateOffset(dateLabel(day)) }}>
                      {day.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                    </span>
                  ))}
              </div>
              <div className="day-row">
                {timelineDays.map((day) => {
                  const iso = dateLabel(day);
                  const resolution = dayIsWorking(iso);
                  const classes = resolution.isWorkingDay ? "" : resolution.exception ? "holiday" : "weekend";
                  return (
                    <span key={day.toISOString()} className={classes} style={{ width: dayWidth }} title={`${formatDate(iso)} · ${resolution.reason}`}>
                      {zoom === "day" || day.getDay() === 1 ? day.getDate() : ""}
                    </span>
                  );
                })}
              </div>
              <div className="today-line" style={{ left: dateOffset(todayLineDate) }} />
            </div>
            <div className="timeline-body" style={{ width: timelineWidth }}>
              <div className="nonworking-layer">
                {timelineDays
                  .filter((day) => !dayIsWorking(dateLabel(day)).isWorkingDay)
                  .map((day) => (
                    <span key={`off-${day.toISOString()}`} className="nonworking-day" style={{ left: dateOffset(dateLabel(day)), width: dayWidth }} />
                  ))}
              </div>
              <svg className="dependency-layer" width={timelineWidth} height={visibleTasks.length * rowHeight} aria-label="Task dependencies">
                <defs>
                  <marker id="dependency-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" fill="#1468c4" />
                  </marker>
                </defs>
                {dependencyLinks.map((link) => (
                  <path key={`${link.predecessorId}-${link.successor.id}-${link.type}`} d={link.path} className="dependency-line" markerEnd="url(#dependency-arrow)">
                    <title>{`${link.predecessor.name} → ${link.successor.name} · ${link.type}${link.lagDays ? `${link.lagDays > 0 ? "+" : ""}${link.lagDays}d` : ""}`}</title>
                  </path>
                ))}
              </svg>
              {visibleTasks.map((task) => (
                <div key={task.id} className={`timeline-row ${selected.includes(task.id) ? "selected" : ""}`} style={{ height: rowHeight }} onClick={() => setSelected([task.id])}>
                  {showBaselineBars && activeBaselineId && baselineTasks.find((snapshot) => snapshot.baselineId === activeBaselineId && snapshot.taskId === task.id) && <span className="baseline-bar" style={{ left: dateOffset(baselineTasks.find((snapshot) => snapshot.baselineId === activeBaselineId && snapshot.taskId === task.id)?.startDate ?? task.start), width: barWidth({ ...task, start: baselineTasks.find((snapshot) => snapshot.baselineId === activeBaselineId && snapshot.taskId === task.id)?.startDate ?? task.start, finish: baselineTasks.find((snapshot) => snapshot.baselineId === activeBaselineId && snapshot.taskId === task.id)?.finishDate ?? task.finish }) }} title="Baseline" />}
                  <div
                    className={`task-bar ${showCriticalPath && task.isCritical ? "critical-bar" : isMilestone(task) ? "milestone" : task.parentId === null ? "summary-bar" : `bar-${task.color}`}`}
                    title={`${task.name} · ${formatDate(task.start)} – ${formatDate(task.finish)}${remainingMarginDays(task) > 0 ? ` + ${remainingMarginDays(task)} d margin` : ""}${task.marginDaysConsumed ? ` · ${task.marginDaysConsumed} of ${task.marginDaysOriginal} d consumed` : ""}`}
                    style={{
                      left:
                        dateOffset(
                          timelineResize?.id === task.id && timelineResize.edge === "start"
                            ? addWorkingDays(task.start, timelineResize.days, calendarId, system)
                            : task.start,
                        ) + (timelineDrag?.id === task.id ? timelineDrag.days * dayWidth : 0),
                      width: barWidth(
                        timelineResize?.id === task.id
                          ? {
                              ...task,
                              start: timelineResize.edge === "start" ? addWorkingDays(task.start, timelineResize.days, calendarId, system) : task.start,
                              finish: timelineResize.edge === "finish" ? addWorkingDays(task.finish, timelineResize.days, calendarId, system) : task.finish,
                            }
                          : task,
                      ),
                    }}
                    onPointerDown={(event) => beginBarDrag(event, task)}
                    onDoubleClick={() => setModalTask(task)}
                  >
                    <span className="progress-fill" style={{ width: `${task.percent}%` }} />
                    {(() => {
                      const until = fixedUntil(task);
                      if (!until || isMilestone(task)) return null;
                      const width = dateOffset(addWorkingDays(until, 1, calendarId, system)) - dateOffset(task.start);
                      return <span className="bar-fixed" style={{ left: 0, width: `${Math.max(0, width)}px` }} title={`Fixed until ${formatFullDate(until)}`} />;
                    })()}
                    {!isMilestone(task) && (
                      <>
                        <span className="bar-grip left" onPointerDown={(event) => beginBarResize(event, task, "start")} />
                        <span className="bar-label">{task.name}{assignedResources(task.id).length > 0 && <small className="bar-resources"> · {assignedResources(task.id).map((resource) => resource?.name).join(", ")}</small>}</span>
                        {showLeave && assignedResources(task.id).flatMap((resource) => resource ? resourceLeave(resource.id).filter((leave) => leave.endDate >= task.start && leave.startDate <= task.finish).map((leave) => {
                          const from = Math.max(0, (parseDate(leave.startDate).getTime() - parseDate(task.start).getTime()) / 86400000);
                          const to = Math.min((parseDate(task.finish).getTime() - parseDate(task.start).getTime()) / 86400000 + 1, (parseDate(leave.endDate).getTime() - parseDate(task.start).getTime()) / 86400000 + 1);
                          return <span key={`${resource.id}-${leave.id}`} className="leave-shade" title={`${resource.name}: ${leave.label}`} style={{ left: `${(from / Math.max(1, (parseDate(task.finish).getTime() - parseDate(task.start).getTime()) / 86400000 + 1)) * 100}%`, width: `${((to - from) / Math.max(1, (parseDate(task.finish).getTime() - parseDate(task.start).getTime()) / 86400000 + 1)) * 100}%`, background: resource.colour }} />;
                        }) : [])}
                        <span className="bar-grip right" onPointerDown={(event) => beginBarResize(event, task, "finish")} />
                      </>
                    )}
{showMarginsOnBars && !isMilestone(task) && !tasks.some((item) => item.parentId === task.id) && remainingMarginDays(task) > 0 && (() => {
                      const remaining = remainingMarginDays(task);
                      const zoneEnd = addWorkingDays(task.finish, remaining, calendarId, system);
                      return <span className="margin-zone" style={{ width: dateOffset(zoneEnd) - dateOffset(task.finish) }} title={`${task.name} · margin zone · ${remaining} d remaining`} />;
                    })()}
                    {isMilestone(task) && <Diamond size={18} fill="currentColor" />}
                  </div>
                </div>
              ))}
              <div className="today-line body-line" style={{ left: dateOffset(todayLineDate) }} />
            </div>
          </div>
          <div className="timeline-controls">
            <span className="control-label">Zoom</span>
            {(["day", "week", "month", "quarter"] as const).map((value) => (
              <button key={value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}>{value}</button>
            ))}
          </div>
        </section>
        </div>
      </div>

      <footer className="statusbar">
        <span><span className="status-dot" /> {tasks.length} tasks in this project</span>
        <span>Calendar: {calendarName}</span>
        <span>{planningDirection === "forward" ? "Forward planning" : "Backward planning"}</span>
        <span className="footer-spacer" />
        <span>Internal workspace · Drag to reschedule · Enter to edit · ⌘Z to undo</span>
      </footer>

      {showMenu && (
        <div className="context-menu" style={{ left: showMenu.x, top: showMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button onClick={() => { setModalTask(taskById.get(showMenu.id) ?? null); setShowMenu(null); }}>Task information <span>↵</span></button>
          {(() => {
            const task = taskById.get(showMenu.id);
            return task && canAdjustTask(task, activeMode, todayLineDate, tasks) === null
              ? <button onClick={() => { setAdjustError(null); setAdjustEdit(null); setAdjustTaskId(showMenu.id); setShowMenu(null); }}><RotateCcw size={14} /> Adjust remaining work</button>
              : null;
          })()}
          <button onClick={() => { addTask(showMenu.id, showMenu.id); setShowMenu(null); }}><Plus size={14} /> Add task</button>
          <button
            onClick={() => {
              duplicateTask(showMenu.id);
              setShowMenu(null);
            }}
          >
            <Copy size={14} /> Duplicate task
          </button>
          {taskById.get(showMenu.id)?.startConstraint && <button onClick={() => { removeConstraint(showMenu.id); setShowMenu(null); }}><RotateCcw size={14} /> Remove constraint</button>}
          <button onClick={() => { setSelected([showMenu.id]); deleteSelected(); setShowMenu(null); }} className="danger"><Trash2 size={14} /> Delete task</button>
          <div className="menu-rule" />
          <button
            onClick={() => {
              const task = taskById.get(showMenu.id);              if (task) commit(tasks.map((item) => (item.id === task.id ? { ...item, duration: 0, isMilestone: true, finish: item.start } : item)));
              setShowMenu(null);
            }}
          >
            Convert to milestone
          </button>
          <button
            onClick={() => {
              const task = taskById.get(showMenu.id);
              if (task) commit(tasks.map((item) => (item.id === task.id ? { ...item, duration: 1, durationUnit: "days", isMilestone: false } : item)));
              setShowMenu(null);
            }}
          >
            Convert to task
          </button>
          <button onClick={() => setShowMenu(null)}>Columns & filters <Columns3 size={14} /></button>
        </div>
      )}

      {modalTask && (
        <div className="modal-backdrop" onClick={() => { setModalTask(null); setRemovalPrompt(null); }}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">TASK INFORMATION</div><h2>{modalTask.name}</h2></div>
              <button className="icon-button" onClick={() => { setModalTask(null); setRemovalPrompt(null); }}><X size={18} /></button>
            </div>
            <div className="modal-grid">
              {(["name", "start", "finish", "duration", "predecessors", "resource", "percent", "notes"] as ColumnKey[]).map((field) => (
                <label key={field}>
                  {field === "percent" ? "% complete" : field}
                  <input
                    type={field === "start" || field === "finish" ? "date" : "text"}
                    value={field === "duration" ? `${modalTask.duration} ${modalTask.durationUnit}` : String((modalTask as unknown as Record<string, unknown>)[field] ?? "")}
                    onChange={(event) => setModalTask({ ...modalTask, [field]: event.target.value })}
                  />
                </label>
              ))}
            </div>
            {(() => {
              const live = taskById.get(modalTask.id) ?? modalTask;
              const segments = allocationSegments(live, system, calendarId);
              const log = live.adjustments ?? [];
              if (!segments.length && !log.length) return null;
              return (
                <div className="adjust-detail">
                  <div className="adjust-detail-head">
                    <b>Workload</b>
                    <span>{displayHours(live.work ?? 0)} h{hasAllocationSegments(live) ? " — read-only: the sum of the fixed and the re-planned hours" : ""}</span>
                  </div>
                  {segments.length > 0 && (
                    <div className="adjust-segments">
                      <div className="eyebrow">ALLOCATION SEGMENTS</div>
                      <table>
                        <thead><tr><th>Segment</th><th>From</th><th>To</th><th>Days</th><th>Hours</th><th>Distribution</th></tr></thead>
                        <tbody>
                          {segments.map((segment, index) => (
                            <tr key={index} className={`segment-${segment.kind}`}>
                              <td>{segment.kind === "fixed" ? "Fixed" : "Planned"}</td>
                              <td>{segment.start}</td>
                              <td>{segment.finish}</td>
                              <td>{segment.days}</td>
                              <td>{displayHours(segment.hours)} h</td>
                              <td>{segment.distribution ? DISTRIBUTION_OPTIONS.find((option) => option.value === segment.distribution)?.label ?? "—" : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {log.length > 0 && (() => {
                    const newest = lastActiveAdjustment(live);
                    const monitoring = activeMode === "monitoring";
                    const plannedSegment = (live.allocations ?? []).find((segment) => segment.kind === "planned");
                    return (
                      <div className="adjust-log">
                        <div className="eyebrow">ADJUSTMENT LOG</div>
                        <ul>
                          {[...log].reverse().map((entry) => {
                            const removed = Boolean(entry.removedAt);
                            const isNewest = !removed && newest?.id === entry.id;
                            return (
                              <li key={entry.id} className={removed ? "removed" : ""}>
                                <div className="adjust-log-line"><b>{entry.reason}</b><span>{entry.userName} · {new Date(entry.at).toLocaleString("en-GB")}</span></div>
                                <div className="adjust-log-meta">Keep until {entry.keepUntil} · finish {entry.oldFinish} → {entry.newFinish} · workload {displayHours(entry.oldWork)} h → {displayHours(entry.newWork)} h · margin {entry.marginConsumed} d · pushed {entry.daysPushed} d</div>
                                {removed
                                  ? <div className="adjust-log-removed">Removed{entry.removedByName ? ` by ${entry.removedByName}` : ""}{entry.removedAt ? ` · ${new Date(entry.removedAt).toLocaleString("en-GB")}` : ""}</div>
                                  : isNewest && monitoring
                                    ? <div className="adjust-log-actions">
                                        <button className="tool-button" onClick={() => {
                                          setAdjustError(null);
                                          setAdjustEdit({
                                            keepUntil: entry.keepUntil,
                                            remainingWork: Math.max(0, plannedSegment?.hours ?? 0),
                                            newFinish: entry.newFinish,
                                            distribution: plannedSegment?.distribution ?? normalizeDistribution(live.distribution),
                                            reason: entry.reason,
                                          });
                                          setAdjustTaskId(live.id);
                                        }}>Edit</button>
                                        <button className="tool-button danger" onClick={() => setRemovalPrompt({ taskId: live.id, mode: "last" })}>Remove</button>
                                      </div>
                                    : null}
                              </li>
                            );
                          })}
                        </ul>
                        {monitoring && log.some((entry) => !entry.removedAt) && (
                          <button className="tool-button danger adjust-remove-all" onClick={() => setRemovalPrompt({ taskId: live.id, mode: "all" })}>Remove all adjustments</button>
                        )}
                      </div>
                    );
                  })()}
                  {activeMode === "monitoring" && removalPrompt && removalPrompt.taskId === live.id && (() => {
                    const preview = previewRemoval(tasks, live.id, adjustmentContext(live), removalPrompt.mode);
                    return (
                      <div className="removal-preview" role="alert">
                        <div className="eyebrow">REMOVE {removalPrompt.mode === "all" ? "ALL ADJUSTMENTS" : "LAST ADJUSTMENT"}</div>
                        {preview
                          ? <>
                              <p>This restores the task to its earlier state. The adjustment log keeps every entry, marked as removed.</p>
                              <dl>
                                <div><dt>Restored finish</dt><dd>{preview.finish}</dd></div>
                                <div><dt>Restored workload</dt><dd>{displayHours(preview.work)} h</dd></div>
                                <div><dt>Margin returned</dt><dd>{preview.marginReturned} d</dd></div>
                                <div><dt>Entries removed</dt><dd>{preview.removed}</dd></div>
                                <div><dt>Project finish</dt><dd>{preview.projectFinishAfter} <small>from {preview.projectFinishBefore}</small></dd></div>
                              </dl>
                              <p className="removal-successors">{preview.successors.length
                                ? `Successors move back: ${preview.successors.map((successor) => `${successor.name} ${successor.oldStart} → ${successor.newStart}`).join(", ")}`
                                : "No successor dates change."}</p>
                            </>
                          : <p>There is nothing to remove.</p>}
                        <div className="removal-actions">
                          <button className="tool-button" onClick={() => setRemovalPrompt(null)}>Cancel</button>
                          <button className="tool-button danger" disabled={!preview} onClick={() => confirmRemoval(live, removalPrompt.mode)}>Remove</button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}
            <div className="modal-actions">
              <div className="modal-actions-left">
                {(() => {
                  const live = taskById.get(modalTask.id) ?? modalTask;
                  if (canAdjustTask(live, activeMode, todayLineDate, tasks) !== null) return null;
                  return <button className="tool-button" onClick={() => { setAdjustError(null); setAdjustEdit(null); setAdjustTaskId(live.id); }} title="Re-plan the remaining work from a chosen date"><RotateCcw size={14} /> Adjust remaining work</button>;
                })()}
              </div>
              <button className="tool-button" onClick={() => { setModalTask(null); setRemovalPrompt(null); }}>Cancel</button>
              <button
                className="tool-button primary"
                onClick={() => {
                  updateTask(modalTask.id, "name", modalTask.name);
                  setTasks((items) => items.map((item) => (item.id === modalTask.id ? modalTask : item)));
                  setModalTask(null);
                  toast("Task updated");
                }}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}

      {adjustTaskId && (() => {
        const task = taskById.get(adjustTaskId);
        if (!task) return null;
        const context = adjustmentContext(task);
        return (
          <AdjustRemainingWorkDialog
            task={task}
            tasks={tasks}
            system={system}
            projectCalendarId={calendarId}
            isAvailable={context.isAvailable}
            availableHours={context.availableHours}
            today={todayLineDate}
            baselineWork={baselineWorkFor(task.id)}
            mode={adjustEdit ? "edit" : "create"}
            initial={adjustEdit ?? undefined}
            onCancel={() => { setAdjustTaskId(null); setAdjustEdit(null); setAdjustError(null); }}
            onApply={(input) => runAdjustmentPlan(task, input, Boolean(adjustEdit))}
          />
        );
      })()}
      {adjustError && <div className="adjust-floating-error" role="alert">{adjustError}</div>}
    </div>
  );
}
