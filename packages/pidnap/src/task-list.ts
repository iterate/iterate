// REFACTOR: This entire file can be deleted once we unify tasks and processes.
// Tasks become processes with restartPolicy: "never" and the dependency system
// handles sequencing. The TaskStateSchema can be merged into RestartingProcessState.
import * as v from "valibot";
import { LazyProcess, ProcessDefinition } from "./lazy-process.ts";
import type { Logger } from "./logger.ts";

// Per-task state
export const TaskStateSchema = v.picklist(["pending", "running", "completed", "failed", "skipped"]);

export type TaskState = v.InferOutput<typeof TaskStateSchema>;

// Schema for named process definition
export const NamedProcessDefinitionSchema = v.object({
  name: v.string(),
  process: ProcessDefinition,
});

export type NamedProcessDefinition = v.InferOutput<typeof NamedProcessDefinitionSchema>;

// A task entry (single or parallel processes) with its state
export interface TaskEntry {
  id: string; // Unique task ID
  processes: NamedProcessDefinition[]; // Array (length 1 = sequential, >1 = parallel)
  state: TaskState;
}

// Simple TaskList state (just running or not)
export type TaskListState = "idle" | "running" | "stopped";

export class TaskList {
  readonly name: string;
  private _tasks: TaskEntry[] = [];
  private _state: TaskListState = "idle";
  private logger: Logger;
  private logFileResolver?: (processName: string) => string | undefined;
  private taskIdCounter = 0;
  private runningProcesses: LazyProcess[] = [];
  private stopRequested = false;
  private runLoopPromise: Promise<void> | null = null;

  constructor(
    name: string,
    logger: Logger,
    initialTasks?: (NamedProcessDefinition | NamedProcessDefinition[])[],
    logFileResolver?: (processName: string) => string | undefined,
  ) {
    this.name = name;
    this.logger = logger;
    this.logFileResolver = logFileResolver;

    // Add initial tasks if provided
    if (initialTasks) {
      for (const task of initialTasks) {
        this.addTask(task);
      }
    }
  }

  get state(): TaskListState {
    return this._state;
  }

  get tasks(): ReadonlyArray<TaskEntry> {
    return this._tasks;
  }

  removeTaskByTarget(target: string | number): TaskEntry {
    const index =
      typeof target === "number" ? target : this._tasks.findIndex((t) => t.id === target);
    if (index < 0 || index >= this._tasks.length) {
      throw new Error(`Task not found: ${target}`);
    }

    const task = this._tasks[index];
    if (task.state === "running") {
      throw new Error(`Cannot remove running task: ${task.id}`);
    }

    this._tasks.splice(index, 1);
    this.logger.info(`Task "${task.id}" removed`);
    return task;
  }

  /**
   * Add a single process or parallel processes as a new task
   * @returns The unique task ID
   */
  addTask(task: NamedProcessDefinition | NamedProcessDefinition[]): string {
    const id = `task-${++this.taskIdCounter}`;
    const processes = Array.isArray(task) ? task : [task];

    const entry: TaskEntry = {
      id,
      processes,
      state: "pending",
    };

    this._tasks.push(entry);
    this.logger.info(`Task "${id}" added with ${processes.length} process(es)`);

    return id;
  }

  /**
   * Begin executing pending tasks
   */
  start(): void {
    if (this._state === "running") {
      throw new Error(`TaskList "${this.name}" is already running`);
    }

    this.stopRequested = false;
    this._state = "running";
    this.logger.info(`TaskList started`);

    // Start the run loop (non-blocking)
    this.runLoopPromise = this.runLoop();
  }

  /**
   * Wait until the TaskList becomes idle (all pending tasks completed)
   */
  async waitUntilIdle(): Promise<void> {
    if (this._state === "idle" || this._state === "stopped") {
      return;
    }

    // Wait for the run loop to complete
    if (this.runLoopPromise) {
      await this.runLoopPromise;
    }
  }

  /**
   * Stop execution and mark remaining tasks as skipped
   */
  async stop(timeout?: number): Promise<void> {
    if (this._state === "idle" || this._state === "stopped") {
      this._state = "stopped";
      return;
    }

    this.stopRequested = true;
    this.logger.info(`Stopping TaskList...`);

    // Stop all currently running processes
    const stopPromises = this.runningProcesses.map((p) => p.stop(timeout));
    await Promise.all(stopPromises);
    this.runningProcesses = [];

    // Mark all pending tasks as skipped
    for (const task of this._tasks) {
      if (task.state === "pending") {
        task.state = "skipped";
      }
    }

    // Wait for run loop to finish
    if (this.runLoopPromise) {
      await this.runLoopPromise;
      this.runLoopPromise = null;
    }

    this._state = "stopped";
    this.logger.info(`TaskList stopped`);
  }

  private async runLoop(): Promise<void> {
    while (this._state === "running" && !this.stopRequested) {
      // Find the next pending task
      const nextTask = this._tasks.find((t) => t.state === "pending");

      if (!nextTask) {
        // No more pending tasks, go back to idle
        this._state = "idle";
        this.logger.info(`All tasks completed, TaskList is idle`);
        break;
      }

      await this.executeTask(nextTask);
    }
  }

  private async executeTask(task: TaskEntry): Promise<void> {
    if (this.stopRequested) {
      task.state = "skipped";
      return;
    }

    task.state = "running";
    const taskNames = task.processes.map((p) => p.name).join(", ");
    this.logger.info(`Executing task "${task.id}": [${taskNames}]`);

    // Create LazyProcess instances for each process in the task
    const lazyProcesses: LazyProcess[] = task.processes.map((p) => {
      const logFile = this.logFileResolver?.(p.name);
      const childLogger = logFile
        ? this.logger.child(p.name, { logFile })
        : this.logger.child(p.name);
      return new LazyProcess(p.name, p.process, childLogger);
    });

    this.runningProcesses = lazyProcesses;

    try {
      // Start all processes (parallel if multiple)
      await Promise.all(lazyProcesses.map((lp) => lp.start()));

      // Wait for all processes to complete
      const results = await Promise.all(lazyProcesses.map((lp) => this.waitForProcess(lp)));

      // Check if any failed
      const anyFailed = results.some((r) => r === "error");

      if (this.stopRequested) {
        task.state = "skipped";
      } else if (anyFailed) {
        task.state = "failed";
        this.logger.warn(`Task "${task.id}" failed`);
      } else {
        task.state = "completed";
        this.logger.info(`Task "${task.id}" completed`);
      }
    } catch (err) {
      task.state = "failed";
      this.logger.error(`Task "${task.id}" error:`, err);
    } finally {
      this.runningProcesses = [];
    }
  }

  private async waitForProcess(lp: LazyProcess): Promise<"stopped" | "error"> {
    const state = await lp.waitForExit();
    return state === "error" ? "error" : "stopped";
  }
}
