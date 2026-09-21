import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Columns3,
  Copy,
  Diamond,
  Download,
  GripVertical,
  LogOut,
  Plus,
  Redo2,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  addWorkingDays,
  findDependencyCycle,
  isoDate,
  resolveWorkingDay,
  workingDaysBetween,
  type PlanningDirection,
} from "@/lib/scheduling-engine";
import { dependenciesForTasks, recalculateTasks, type PlannerTask } from "@/lib/planner-model";
import { CALENDAR_TYPE_LABELS, useCalendarStore } from "@/lib/calendar-store";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Task = PlannerTask;
type ColumnKey = "id" | "wbs" | "name" | "duration" | "start" | "finish" | "predecessors" | "resource" | "percent" | "notes";

const rowHeight = 42;
const todayLineDate = "2025-04-17";
const columnDefs: { key: ColumnKey; label: string; width: number }[] = [
  { key: "id", label: "ID", width: 58 },
  { key: "wbs", label: "WBS", width: 70 },
  { key: "name", label: "Task name", width: 238 },
  { key: "duration", label: "Duration", width: 105 },
  { key: "start", label: "Start", width: 112 },
  { key: "finish", label: "Finish", width: 112 },
  { key: "predecessors", label: "Predecessors", width: 128 },
  { key: "resource", label: "Resource", width: 118 },
  { key: "percent", label: "% complete", width: 96 },
  { key: "notes", label: "Notes", width: 160 },
];

const parseDate = (date: string) => new Date(`${date}T12:00:00`);
const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parseDate(date));

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

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const {
    system,
    activeProject,
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
  } = useCalendarStore();
  const calendarId = activeProject.calendarId;
  const calendarName = system.calendars.find((calendar) => calendar.id === calendarId)?.name ?? "Unlinked";
  useEffect(() => {
    setPlanningDirection(activeProject.schedulingDirection);
  }, [activeProjectId, activeProject.schedulingDirection]);

  const [selected, setSelected] = useState<string[]>(["3"]);
  const [editing, setEditing] = useState<{ id: string; field: ColumnKey } | null>(null);
  const [resourceEditor, setResourceEditor] = useState<{ taskId: string; query: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [zoom, setZoom] = useState<"day" | "week" | "month" | "quarter">("week");
  const [split, setSplit] = useState(58);
  const [showMenu, setShowMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [modalTask, setModalTask] = useState<Task | null>(null);
  const [history, setHistory] = useState<Task[][]>([]);
  const [future, setFuture] = useState<Task[][]>([]);
  const [query, setQuery] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectHighlight, setProjectHighlight] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("vintage-gantt-project-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const [expandedGroups, setExpandedGroups] = useState<{ active: boolean; archived: boolean }>({ active: true, archived: false });
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [timelineDrag, setTimelineDrag] = useState<{ id: string; days: number } | null>(null);
  const [timelineResize, setTimelineResize] = useState<{ id: string; days: number; edge: "start" | "finish" } | null>(null);
  const [recalcDialog, setRecalcDialog] = useState(false);

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

  useEffect(() => {
    try { localStorage.setItem("vintage-gantt-project-sidebar-collapsed", String(sidebarCollapsed)); } catch { /* storage is optional */ }
  }, [sidebarCollapsed]);

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

  const visibleTasks = useMemo(() => {
    const visible: Task[] = [];
    const walk = (parentId: string | null) =>
      tasks
        .filter((task) => task.parentId === parentId)
        .forEach((task) => {
          if (!query || task.name.toLowerCase().includes(query.toLowerCase())) visible.push(task);
          if (!task.collapsed) walk(task.id);
        });
    walk(null);
    return visible;
  }, [tasks, query]);

  const planningAnchor = new Date(`${todayLineDate}T12:00:00`);
  const taskTimestamps = tasks.flatMap((task) => [
    new Date(`${task.start}T12:00:00`).getTime(),
    new Date(`${task.finish}T12:00:00`).getTime(),
  ]);
  const earliestTaskDate = taskTimestamps.length ? new Date(Math.min(...taskTimestamps)) : planningAnchor;
  const latestTaskDate = taskTimestamps.length ? new Date(Math.max(...taskTimestamps)) : planningAnchor;
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
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const isMilestone = (task: Task) => task.duration === 0 && !tasks.some((candidate) => candidate.parentId === task.id);
  const assignedResources = (taskId: string) => assignments.filter((assignment) => assignment.taskId === taskId).map((assignment) => resources.find((resource) => resource.id === assignment.resourceId)).filter(Boolean);
  const dayIsWorking = (date: string) => resolveWorkingDay(date, calendarId, system);
  const filteredProjectGroups = useMemo(() => {
    const matching = projects.filter((project) => project.name.toLowerCase().includes(projectSearch.toLowerCase()));
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
    setTasks(result.tasks);
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
    recalculate(normalized, "forward", false, "", manuallyAnchoredId ? [manuallyAnchoredId] : []);
    return true;
  };

  const updateTask = (id: string, field: ColumnKey, value: string) => {
    const next = tasks.map((task) => {
      if (task.id !== id) return task;
      if (field === "duration") {
        const [amount, unit] = value.trim().split(/\s+/);
        const parsed = Number(amount);
        const duration = Number.isFinite(parsed) ? Math.max(0, parsed) : task.duration;
        const weeks = unit === "weeks" || unit === "w";
        const summary = tasks.some((candidate) => candidate.parentId === task.id);
        const milestone = duration === 0 && !summary;
        return {
          ...task,
          duration,
          durationUnit: (weeks ? "weeks" : "days") as "days" | "weeks",
          isMilestone: milestone,
          finish: milestone
            ? task.start
            : addWorkingDays(task.start, weeks ? duration * 5 - 1 : Math.max(0, duration - 1), calendarId, system),
        };
      }
      if (field === "start") {
        const start = value || task.start;
        const milestone = task.duration === 0 && !tasks.some((candidate) => candidate.parentId === task.id);
        return {
          ...task,
          start,
          isMilestone: milestone,
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
      if (field === "percent") return { ...task, percent: Math.max(0, Math.min(100, Number(value.replace("%", "")) || 0)) };
      if (field === "name") return { ...task, name: value.trim() || task.name };
      return { ...task, [field]: value };
    });
    commit(next);
    setEditing(null);
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
        commit(tasks.map((item) => (item.id === task.id ? { ...item, start, finish } : item)), task.id);
        toast(`${task.name} moved to ${formatDate(start)}`);
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
        commit(tasks.map((item) => (item.id === task.id ? { ...item, start, finish, duration, durationUnit: "days" as const } : item)), task.id);
        toast(`${task.name} duration set to ${duration} working days`);
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
        const x1 = dateOffset(predecessor.start) + barWidth(predecessor);
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

  return (
    <div className="planner-shell" onClick={() => setShowMenu(null)}>
      <header className="planner-topbar">
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
        <div className="top-actions">
          <div className="save-state"><span className="live-dot" /> Saved just now</div>
          <button className="icon-button" title="Help"><CircleHelp size={17} /></button>
          <button className="avatar" title={user?.name ?? "Account"}>{user?.name?.slice(0, 1) ?? "M"}</button>
          <button className="icon-button" onClick={() => { signOut(); navigate("/"); }} title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>

      <div className="project-toolbar">
        <div className="toolbar-left">
          <button className="tool-button primary" onClick={() => addTask()}><Plus size={16} /> New task</button>
          <button className="tool-button" onClick={undo} disabled={!history.length}><Undo2 size={16} /></button>
          <button className="tool-button" onClick={redo} disabled={!future.length}><Redo2 size={16} /></button>
          <button className="tool-button" onClick={openRecalculate}><Sparkles size={15} /> Recalculate</button>
          <span className="toolbar-divider" />
          <button className="tool-button" onClick={() => selected[0] && indent(selected[0])}>→ Indent</button>
          <button className="tool-button" onClick={() => selected[0] && indent(selected[0], true)}>← Outdent</button>
          <button className="tool-button" onClick={deleteSelected}><Trash2 size={15} /> Delete</button>
        </div>
        <div className="toolbar-right">
          <div className="search-box"><Search size={15} /><input placeholder="Search projects and tasks" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <button className="tool-button"><Download size={15} /> Export</button>
          <button className="tool-button" onClick={() => toast("You are viewing your team dashboard")}><UserRound size={15} /> My dashboard</button>
          <button className="tool-button" onClick={openProjectSettings}><CalendarDays size={15} /> Project calendar</button>
          <button className="tool-button" onClick={() => navigate("/calendars")}><Settings2 size={15} /></button>
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
                .filter((column) => column.key === "id" || !hidden.includes(column.key))
                .map((column) => (
                  <div
                    key={column.key}
                    className="grid-head-cell"
                    style={{ width: column.width }}
                    onContextMenu={(event) => { event.preventDefault(); toast(`${column.label}: column options ready`); }}
                  >
                    {column.label}
                    <ChevronsUpDown size={12} />
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
                    .filter((column) => column.key === "id" || !hidden.includes(column.key))
                    .map((column) => {
                      const value =
                        column.key === "id"
                          ? task.id
                          : column.key === "wbs"
                            ? getWbs(task, tasks)
                            : column.key === "duration"
                              ? `${task.duration} ${task.durationUnit === "days" ? "d" : "w"}`
                              : column.key === "percent"
                                ? `${task.percent}%`
                                : column.key === "resource"
                                  ? assignedResources(task.id).map((resource) => resource?.name).join(", ")
                                  : String((task as unknown as Record<string, unknown>)[column.key] ?? "");
                      const isName = column.key === "name";
                      const canEdit = !["id", "wbs"].includes(column.key) && !(summary && ["start", "finish", "duration"].includes(column.key));
                      return (
                        <div
                          key={column.key}
                          className={`grid-cell ${isName ? "name-cell" : ""} ${column.key === "resource" ? "resource-cell" : ""} ${!canEdit ? "readonly" : ""}`}
                          style={{ width: column.width }}
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
                          {isName && <span className="row-handle"><GripVertical size={13} /></span>}
                          {isName && summary && (
                            <button className="collapse-button" onClick={(event) => { event.stopPropagation(); toggleCollapse(task.id); }}>
                              {task.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            </button>
                          )}
                          {isName && !summary && <span className="task-spacer" />}
                          {column.key === "resource" ? (() => {
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
                              type={column.key === "start" || column.key === "finish" ? "date" : "text"}
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
                  <div
                    className={`task-bar ${isMilestone(task) ? "milestone" : task.parentId === null ? "summary-bar" : `bar-${task.color}`}`}
                    title={`${task.name} · ${formatDate(task.start)} – ${formatDate(task.finish)}`}
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
                        {assignedResources(task.id).flatMap((resource) => resource ? resourceLeave(resource.id).filter((leave) => leave.endDate >= task.start && leave.startDate <= task.finish).map((leave) => {
                          const from = Math.max(0, (parseDate(leave.startDate).getTime() - parseDate(task.start).getTime()) / 86400000);
                          const to = Math.min((parseDate(task.finish).getTime() - parseDate(task.start).getTime()) / 86400000 + 1, (parseDate(leave.endDate).getTime() - parseDate(task.start).getTime()) / 86400000 + 1);
                          return <span key={`${resource.id}-${leave.id}`} className="leave-shade" title={`${resource.name}: ${leave.label}`} style={{ left: `${(from / Math.max(1, (parseDate(task.finish).getTime() - parseDate(task.start).getTime()) / 86400000 + 1)) * 100}%`, width: `${((to - from) / Math.max(1, (parseDate(task.finish).getTime() - parseDate(task.start).getTime()) / 86400000 + 1)) * 100}%`, background: resource.colour }} />;
                        }) : [])}
                        <span className="bar-grip right" onPointerDown={(event) => beginBarResize(event, task, "finish")} />
                      </>
                    )}
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
          <button onClick={() => { setSelected([showMenu.id]); deleteSelected(); setShowMenu(null); }} className="danger"><Trash2 size={14} /> Delete task</button>
          <div className="menu-rule" />
          <button
            onClick={() => {
              const task = taskById.get(showMenu.id);
              if (task) commit(tasks.map((item) => (item.id === task.id ? { ...item, duration: 0, isMilestone: true, finish: item.start } : item)));
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
