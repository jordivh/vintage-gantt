import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
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
  LogOut,
  PencilRuler,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Layers,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
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
import { applyPlanningModeMargins, applyReplanMargins, dependenciesForTasks, DISTRIBUTION_OPTIONS, fieldModeReadOnly, formatPredecessorsForDisplay, marginAfterPctChange, normalizeDistribution, normalizeWorkHours, orderTasksForDisplay, planFinishDate, recalculateTasks, replanScopeIds, resolvePredecessorInput, settleMonitoringPlan, startConstraintFor, startEditRestriction, withCalculatedPlanningFields, type PlannerTask, type PlanMode, type ReplanScope } from "@/lib/planner-model";
import { leafMarginTotals, marginRowsFor } from "@/lib/margin-report";
import { leaveLabels, taskLeaveInfo } from "@/lib/task-leave";
import { CALENDAR_TYPE_LABELS, useCalendarStore, type Baseline } from "@/lib/calendar-store";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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
  { key: "variance", label: "Variance", width: 88 },
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
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
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
  } = useCalendarStore();
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
  const [zoom, setZoom] = useState<"day" | "week" | "month" | "quarter">("week");
  const [split, setSplit] = useState(58);
  const [showMenu, setShowMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [modalTask, setModalTask] = useState<Task | null>(null);
  const [cellError, setCellError] = useState<{ taskId: string; column: ColumnKey; message: string } | null>(null);
  const [marginNotice, setMarginNotice] = useState<{ taskId: string; message: string } | null>(null);
  // Reported under the Finish cell: how a task's finish move used its reserve.
  const [absorptionNotice, setAbsorptionNotice] = useState<{ taskId: string; message: string } | null>(null);
  const [history, setHistory] = useState<Task[][]>([]);
  const [future, setFuture] = useState<Task[][]>([]);
  const [query, setQuery] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
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
  const [baselineListOpen, setBaselineListOpen] = useState(false);

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
  const [recalcDate, setRecalcDate] = useState("2025-04-01");
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

  const updateTask = (id: string, field: ColumnKey, value: string) => {
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
    commit(next);
    setEditing(null);
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

  const addTask = (parentId: string | null = null, afterId?: string) => {
    const id = String(Date.now());
    const task: Task = {
      id,
      parentId,
      name: "New task",
      duration: 1,
      durationUnit: "days",
      work: 0,
      start: "2025-05-02",
      finish: "2025-05-02",
      isMilestone: false,
      predecessors: "",
      resource: "",
      percent: 0,
      notes: "",
      color: "sage",
    };
    const index = afterId ? tasks.findIndex((item) => item.id === afterId) + 1 : tasks.length;
    commit([...tasks.slice(0, index), task, ...tasks.slice(index)]);
    setSelected([id]);
    setEditing({ id, field: "name" });
    setDraft(task.name);
  };

  const deleteSelected = () => {
    if (!selected.length) return;
    commit(tasks.filter((task) => !selected.includes(task.id) && !selected.includes(task.parentId ?? "")));
    setSelected([]);
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
      setEditing(null);
      setCellError(null);
      setMarginNotice(null);
      setAbsorptionNotice(null);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      updateTask(task.id, field, draft);
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
        } else addTask(task.parentId);
      } else if (nextColumn) {
        setEditing({ id: task.id, field: nextColumn.key });
        setDraft(String((task as unknown as Record<string, unknown>)[nextColumn.key] ?? ""));
      }
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
    toast.success("This version is now in Monitoring mode");
  };
  // The report looks at the active project and plan version only; when a baseline
  // is being viewed, hand it over so "became critical" compares the right float.
  const openMarginReport = () => {
    setOverflowOpen(false);
    navigate(activeBaselineId ? `/reports/margins?baseline=${encodeURIComponent(activeBaselineId)}` : "/reports/margins");
  };
  // Capturing a baseline is the door into Monitoring: the plan is frozen as the
  // reference, then we offer the switch. "Later" leaves it locked open.
  const openBaseline = () => {
    const count = baselines.filter((baseline) => baseline.projectId === activeProjectId).length + 1;
    setBaselineName(`Baseline ${count}`);
    setBaselineDate(todayLineDate);
    setBaselineDialog(true);
    setOverflowOpen(false);
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
    setBaselineListOpen(false);
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
    <div className="planner-shell" onClick={() => { setShowMenu(null); setViewOpen(false); setOverflowOpen(false); setBaselineListOpen(false); }}>
      <header className="planner-topbar planner-context-bar">
        <div className="brand-lockup">
          <div className="brand-mark">⌁</div>
          <div>
            <button className="eyebrow breadcrumb-button" onClick={() => navigate("/projects")}>MY DASHBOARD / PROJECT CATALOG</button>
            <h1 className="planner-project-heading" title={activeProject.name}>{activeProject.name}</h1>
          </div>
        </div>
        <nav className="topnav">
          <button className="tool-button primary" onClick={() => navigate("/dashboard")}>Planner</button>
          <button className="tool-button" onClick={() => navigate("/projects")}>Projects</button>
          <button className="tool-button" onClick={() => navigate("/calendars")}>Calendars</button>
          <button className="tool-button" onClick={() => navigate("/resources")}>Resources</button>
        </nav>
        <div className="context-selectors">
          <label>Version <select className="context-select" value={activeVersionId} onChange={(event) => { setHistory([]); setFuture([]); setActiveVersion(event.target.value); }}>
            {planVersions.filter((version) => version.projectId === activeProjectId).map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}
          </select></label>
          <label>Baseline <select className="context-select" value={activeBaselineId} onChange={(event) => setActiveBaselineId(event.target.value)}><option value="">No baseline</option>{baselines.filter((baseline) => baseline.projectId === activeProjectId).map((baseline) => <option key={baseline.id} value={baseline.id}>{baseline.name}</option>)}          </select></label>
          <button className="tool-button quiet baseline-action" onClick={openBaseline} title="Capture the current version as a baseline"><FileSpreadsheet size={14} /> Set baseline</button>
          <div className="toolbar-popover-wrap">
            <button
              className="tool-button quiet baseline-action"
              onClick={(event) => { event.stopPropagation(); setBaselineError(null); setBaselineListOpen((open) => !open); }}
              title="Saved baselines for this project — delete one from here"
            ><Layers size={14} /> Baselines ({projectBaselines.length})</button>
            {baselineListOpen && (
              <div className="toolbar-popover baseline-popover" onClick={(event) => event.stopPropagation()}>
                <div className="popover-heading"><b>SAVED BASELINES</b><button onClick={() => setBaselineListOpen(false)}><X size={14} /></button></div>
                {baselineError && <p className="baseline-error" role="alert"><TriangleAlert size={13} /> {baselineError}</p>}
                {projectBaselines.length === 0 && <p className="baseline-empty">No baseline captured for {activeProject.name} yet.</p>}
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
          <span
            className={`mode-badge ${activeMode}`}
            title={modeBadgeTitle}
          >
            {activeMode === "planning" ? <PencilRuler size={13} /> : <Activity size={13} />}
            {activeMode === "planning" ? "Planning" : "Monitoring"}
          </span>
          {activeMode === "planning" && (versionHasBaseline
            ? <button className="mode-switch" onClick={switchToMonitoring}>Switch to Monitoring</button>
            : <button className="mode-switch locked" aria-disabled title="Set a baseline first." onClick={() => toast("Set a baseline first.")}>Monitoring locked</button>)}
          <button className="context-margin" onClick={openMarginReport} title="Project margin totals for this plan version — leaf tasks only, exactly what the margin report shows">
            Margin <b>{marginTotals.planned} d</b> planned · <b>{marginTotals.consumed} d</b> consumed · <b>{marginTotals.remaining} d</b> remaining
          </button>
        </div>
        <div className="top-actions">
          <div className="save-state"><span className="live-dot" /> Saved just now</div>
          <button className="icon-button" title="Help"><CircleHelp size={17} /></button>
          <button className="avatar" title={user?.name ?? "Account"}>{user?.name?.slice(0, 1) ?? "M"}</button>
          <button className="icon-button" onClick={() => { signOut(); navigate("/"); }} title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>

      <div className="project-toolbar action-toolbar" onClick={(event) => event.stopPropagation()}>
        <div className="toolbar-left task-actions">
          <button className="tool-button primary" onClick={() => addTask()}><Plus size={16} /> New task</button>
          <span className="toolbar-divider" />
          <button className="icon-button" title="Indent (Tab)" aria-label="Indent (Tab)" disabled={!selected.length} onClick={() => selected[0] && indent(selected[0])}><IndentIncrease size={16} /></button>
          <button className="icon-button" title="Outdent (Shift+Tab)" aria-label="Outdent (Shift+Tab)" disabled={!selected.length} onClick={() => selected[0] && indent(selected[0], true)}><IndentDecrease size={16} /></button>
          <button className="icon-button" title="Delete (Delete)" aria-label="Delete (Delete)" disabled={!selected.length} onClick={deleteSelected}><Trash2 size={15} /></button>
          <button className="icon-button" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled={!history.length} onClick={undo}><Undo2 size={15} /></button>
          <button className="icon-button" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled={!future.length} onClick={redo}><Redo2 size={15} /></button>
        </div>
        <div className="toolbar-right view-actions">
          <div className="search-box"><Search size={15} /><input placeholder="Search projects and tasks" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="toolbar-zoom" aria-label="Zoom"><span>Zoom</span>{(["day", "week", "month", "quarter"] as const).map((value) => <button key={value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}>{value}</button>)}</div>
          <div className="toolbar-popover-wrap"><button className="tool-button quiet" onClick={() => { setViewOpen((open) => !open); setOverflowOpen(false); }}><Eye size={15} /> View</button>{viewOpen && <div className="toolbar-popover view-popover" onClick={(event) => event.stopPropagation()}>
            <div className="popover-heading"><b>VIEW</b><button onClick={() => setViewOpen(false)}><X size={14} /></button></div>
            <label><input type="checkbox" checked={showCriticalPath} onChange={(event) => setShowCriticalPath(event.target.checked)} /> Critical path</label>
            <label><input type="checkbox" checked={showMarginsOnBars} onChange={(event) => setShowMarginsOnBars(event.target.checked)} /> Margin zones</label>
            <label><input type="checkbox" checked={showBaselineBars} onChange={(event) => setShowBaselineBars(event.target.checked)} /> Baseline bars</label>
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
            <div className="sidebar-search"><Search size={14} /><input autoComplete="off" placeholder="Search projects" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setProjectHighlight((index) => Math.min(projectResults.length - 1, index + 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setProjectHighlight((index) => Math.max(0, index - 1)); } if (event.key === "Enter" && projectResults[projectHighlight]) { event.preventDefault(); selectProject(projectResults[projectHighlight].id); } if (event.key === "Escape") setProjectSearch(""); }} /></div>
            <div className="sidebar-projects">
              {(["active", "archived"] as const).map((group) => { const list = filteredProjectGroups[group]; const expanded = expandedGroups[group]; return <div className="sidebar-group" key={group}><button className="sidebar-group-header" onClick={() => setExpandedGroups((current) => ({ ...current, [group]: !current[group] }))}><span>{expanded ? "⌄" : "›"} {group === "active" ? "Active" : "Archived"} <small>{list.length}</small></span></button>{expanded && <div className="sidebar-project-list">{list.map((project, index) => { const projectTaskList = projectTasks(project.id); const first = projectTaskList[0]; const finish = projectTaskList.length ? projectTaskList.reduce((latest, task) => task.finish > latest ? task.finish : latest, first.finish) : project.startDate; return <button key={project.id} title={project.name} className={`sidebar-project ${project.id === activeProjectId ? "current" : ""} ${index === projectHighlight && projectSearch ? "highlighted" : ""}`} onClick={() => selectProject(project.id)}><b>{project.name}</b><small>{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${project.startDate}T12:00:00`))} - {new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${finish}T12:00:00`))} · {projectTaskList.length} tasks</small></button>; })}{!list.length && <span className="sidebar-empty">No projects match</span>}</div>}</div>; })}
              {!filteredProjectGroups.active.length && !filteredProjectGroups.archived.length && <div className="sidebar-no-results">No projects match<button onClick={() => setProjectSearch("")}>Clear search</button></div>}
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
                                              return `${days >= 0 ? "+" : ""}${days} d`;
                                            })()
                                    : column.key === "resource"
                                  ? assignedResources(task.id).map((resource) => resource?.name).join(", ")
                                  : column.key === "availability"
                                    ? `${formatAvailableHours(leaveInfo.get(task.id)?.availableHours ?? 0)} h`
                                  : String((task as unknown as Record<string, unknown>)[column.key] ?? "");
                      const isName = column.key === "name";
                      const modeLock = fieldModeReadOnly(column.key, activeMode);
                      const milestone = isMilestone(task);
                      const structuralLock = ["id", "wbs", "availability", "totalFloat", "marginOriginal", "marginConsumed", "marginRemaining", "baselineStart", "baselineFinish", "variance"].includes(column.key) || (summary && ["start", "finish", "duration", "margin", "work"].includes(column.key)) || (milestone && column.key === "work") || ((summary || milestone) && column.key === "distribution");
                      const canEdit = !structuralLock && !modeLock;
                      const readOnlyReason = modeLock ?? (milestone && column.key === "work" ? "Milestones have no work." : summary ? "Summary rows roll up their children." : structuralLock ? "Calculated column — not editable." : undefined);
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
                              onChange={(event) => setDraft(event.target.value)}
                              onFocus={(event) => { if (isName && (task.name === "New task" || task.name === "Nieuwe taak")) event.currentTarget.select(); }}
                              onKeyDown={(event) => handleKey(event, task, column.key)}
                              onBlur={() => updateTask(task.id, column.key, draft)}
                            />
                          ) : (
                            <span style={isName ? { paddingLeft: depth * 17 } : undefined} className={isName && summary ? "summary-name" : ""}>
                              {value}
                            </span>
                          )}
                          {column.key === "resource" && (() => {
                            const info = leaveInfo.get(task.id);
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
          <button onClick={() => { addTask(showMenu.id, showMenu.id); setShowMenu(null); }}><Plus size={14} /> Add task</button>
          <button
            onClick={() => {
              const source = taskById.get(showMenu.id);
              if (source) {
                commit([...tasks, { ...source, id: String(Date.now()), name: `${source.name} copy` }]);
                toast("Task duplicated");
              }
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
        <div className="modal-backdrop" onClick={() => setModalTask(null)}>
          <div className="task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><div className="eyebrow">TASK INFORMATION</div><h2>{modalTask.name}</h2></div>
              <button className="icon-button" onClick={() => setModalTask(null)}><X size={18} /></button>
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
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setModalTask(null)}>Cancel</button>
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
    </div>
  );
}
