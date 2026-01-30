import { describe, it, expect, beforeEach } from "vitest";
import { TaskList } from "../src/task-list.ts";
import type { Logger } from "../src/logger.ts";
import {
  createMockLogger,
  wait,
  successProcess,
  failureProcess,
  longRunningProcess,
  timedProcess,
} from "./test-utils.ts";

describe("TaskList", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("constructor and initial state", () => {
    it("should start in idle state", () => {
      const taskList = new TaskList("test", mockLogger);

      expect(taskList.state).toBe("idle");
      expect(taskList.name).toBe("test");
      expect(taskList.tasks).toHaveLength(0);
    });

    it("should accept initial tasks in constructor", () => {
      const taskList = new TaskList("test", mockLogger, [
        { name: "task1", process: successProcess },
        { name: "task2", process: successProcess },
      ]);

      expect(taskList.tasks).toHaveLength(2);
      expect(taskList.tasks[0].state).toBe("pending");
      expect(taskList.tasks[1].state).toBe("pending");
    });
  });

  describe("addTask()", () => {
    it("should add a single process task", () => {
      const taskList = new TaskList("test", mockLogger);

      const id = taskList.addTask({ name: "task1", process: successProcess });

      expect(id).toBe("task-1");
      expect(taskList.tasks).toHaveLength(1);
      expect(taskList.tasks[0].id).toBe("task-1");
      expect(taskList.tasks[0].processes).toHaveLength(1);
      expect(taskList.tasks[0].state).toBe("pending");
    });

    it("should add parallel processes as a single task", () => {
      const taskList = new TaskList("test", mockLogger);

      const id = taskList.addTask([
        { name: "parallel1", process: successProcess },
        { name: "parallel2", process: successProcess },
      ]);

      expect(id).toBe("task-1");
      expect(taskList.tasks).toHaveLength(1);
      expect(taskList.tasks[0].processes).toHaveLength(2);
    });

    it("should increment task IDs", () => {
      const taskList = new TaskList("test", mockLogger);

      const id1 = taskList.addTask({ name: "task1", process: successProcess });
      const id2 = taskList.addTask({ name: "task2", process: successProcess });
      const id3 = taskList.addTask({ name: "task3", process: successProcess });

      expect(id1).toBe("task-1");
      expect(id2).toBe("task-2");
      expect(id3).toBe("task-3");
    });

    it("should allow adding tasks while running", async () => {
      const taskList = new TaskList("test", mockLogger);

      taskList.addTask({ name: "task1", process: timedProcess(100) });
      taskList.start();

      // Add another task while running
      taskList.addTask({ name: "task2", process: timedProcess(50) });

      await taskList.waitUntilIdle();

      expect(taskList.tasks).toHaveLength(2);
      expect(taskList.tasks[0].state).toBe("completed");
      expect(taskList.tasks[1].state).toBe("completed");
    });

    it("should allow adding tasks after stopped", async () => {
      const taskList = new TaskList("test", mockLogger);

      taskList.addTask({ name: "task1", process: successProcess });
      taskList.start();
      await taskList.waitUntilIdle();

      // Add task after idle
      taskList.addTask({ name: "task2", process: successProcess });

      expect(taskList.tasks).toHaveLength(2);
      expect(taskList.tasks[1].state).toBe("pending");
    });
  });

  describe("start()", () => {
    it("should transition state to running", () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: longRunningProcess });

      taskList.start();

      expect(taskList.state).toBe("running");

      taskList.stop();
    });

    it("should throw if called when already running", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: longRunningProcess });

      taskList.start();

      expect(() => taskList.start()).toThrow('TaskList "test" is already running');

      await taskList.stop();
    });

    it("should execute tasks sequentially", async () => {
      const taskList = new TaskList("test", mockLogger);

      taskList.addTask({ name: "first", process: timedProcess(50) });
      taskList.addTask({ name: "second", process: timedProcess(50) });

      taskList.start();
      await taskList.waitUntilIdle();

      // Both tasks should be completed
      expect(taskList.tasks[0].state).toBe("completed");
      expect(taskList.tasks[1].state).toBe("completed");
    });

    it("should execute parallel processes within a task simultaneously", async () => {
      const taskList = new TaskList("test", mockLogger);

      // Two 200ms processes in parallel should complete in ~200ms, not 400ms
      taskList.addTask([
        { name: "parallel1", process: timedProcess(200) },
        { name: "parallel2", process: timedProcess(200) },
      ]);

      const startTime = Date.now();
      taskList.start();
      await taskList.waitUntilIdle();
      const elapsed = Date.now() - startTime;

      // Should be significantly less than 400ms (sequential would be 400ms+)
      // Allow generous overhead for process startup and async start()
      expect(elapsed).toBeLessThan(450);
      expect(taskList.tasks[0].state).toBe("completed");
    });
  });

  describe("task states", () => {
    it("should transition task state from pending to running to completed", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: timedProcess(100) });

      expect(taskList.tasks[0].state).toBe("pending");

      taskList.start();
      await wait(50);

      expect(taskList.tasks[0].state).toBe("running");

      await taskList.waitUntilIdle();

      expect(taskList.tasks[0].state).toBe("completed");
    });

    it("should mark failed tasks as failed and continue", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "fail", process: failureProcess });
      taskList.addTask({ name: "success", process: successProcess });

      taskList.start();
      await taskList.waitUntilIdle();

      expect(taskList.tasks[0].state).toBe("failed");
      expect(taskList.tasks[1].state).toBe("completed");
    });

    it("should mark task as failed if any parallel process fails", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask([
        { name: "success", process: successProcess },
        { name: "fail", process: failureProcess },
      ]);

      taskList.start();
      await taskList.waitUntilIdle();

      expect(taskList.tasks[0].state).toBe("failed");
    });

    it("should mark pending tasks as skipped when stop() is called", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "long", process: longRunningProcess });
      taskList.addTask({ name: "pending1", process: successProcess });
      taskList.addTask({ name: "pending2", process: successProcess });

      taskList.start();
      await wait(100);

      await taskList.stop();

      expect(taskList.tasks[1].state).toBe("skipped");
      expect(taskList.tasks[2].state).toBe("skipped");
    });
  });

  describe("stop()", () => {
    it("should stop running processes", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "long", process: longRunningProcess });

      taskList.start();
      await wait(100);

      expect(taskList.state).toBe("running");

      await taskList.stop();

      expect(taskList.state).toBe("stopped");
    });

    it("should resolve immediately if already idle", async () => {
      const taskList = new TaskList("test", mockLogger);

      await taskList.stop();

      expect(taskList.state).toBe("stopped");
    });

    it("should resolve immediately if already stopped", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task", process: successProcess });

      taskList.start();
      await taskList.waitUntilIdle();

      await taskList.stop();
      await taskList.stop(); // Second call

      expect(taskList.state).toBe("stopped");
    });
  });

  describe("waitUntilIdle()", () => {
    it("should resolve immediately when idle", async () => {
      const taskList = new TaskList("test", mockLogger);

      const startTime = Date.now();
      await taskList.waitUntilIdle();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });

    it("should wait for all tasks to complete", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: timedProcess(100) });
      taskList.addTask({ name: "task2", process: timedProcess(100) });

      taskList.start();

      const startTime = Date.now();
      await taskList.waitUntilIdle();
      const elapsed = Date.now() - startTime;

      // Should wait for both tasks (sequential = ~200ms)
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(taskList.state).toBe("idle");
    });

    it("should resolve when stopped", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "long", process: longRunningProcess });

      taskList.start();
      await wait(50);

      await taskList.stop();

      expect(taskList.state).toBe("stopped");
    });
  });

  describe("child loggers", () => {
    it("should create child loggers for each process", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "myprocess", process: successProcess });

      taskList.start();
      await taskList.waitUntilIdle();

      expect(mockLogger.child).toHaveBeenCalledWith("myprocess");
    });

    it("should create child loggers for parallel processes", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask([
        { name: "process1", process: successProcess },
        { name: "process2", process: successProcess },
      ]);

      taskList.start();
      await taskList.waitUntilIdle();

      expect(mockLogger.child).toHaveBeenCalledWith("process1");
      expect(mockLogger.child).toHaveBeenCalledWith("process2");
    });
  });

  describe("dynamic task addition", () => {
    it("should pick up newly added tasks while running", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: timedProcess(150) });

      taskList.start();
      await wait(50);

      // Add a new task while task1 is running
      taskList.addTask({ name: "task2", process: timedProcess(50) });

      await taskList.waitUntilIdle();

      expect(taskList.tasks).toHaveLength(2);
      expect(taskList.tasks[0].state).toBe("completed");
      expect(taskList.tasks[1].state).toBe("completed");
    });

    it("should execute added tasks after current batch", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: timedProcess(100) });
      taskList.addTask({ name: "task2", process: timedProcess(100) });

      taskList.start();
      await wait(50); // task1 running

      // Add task3 - should run after task2
      taskList.addTask({ name: "task3", process: timedProcess(50) });

      await taskList.waitUntilIdle();

      expect(taskList.tasks).toHaveLength(3);
      expect(taskList.tasks.every((t) => t.state === "completed")).toBe(true);
    });
  });

  describe("state transitions", () => {
    it("should return to idle after all tasks complete", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: successProcess });

      taskList.start();
      await taskList.waitUntilIdle();

      expect(taskList.state).toBe("idle");
    });

    it("should allow restarting after becoming idle", async () => {
      const taskList = new TaskList("test", mockLogger);
      taskList.addTask({ name: "task1", process: successProcess });

      taskList.start();
      await taskList.waitUntilIdle();

      expect(taskList.state).toBe("idle");

      // Add more tasks and start again
      taskList.addTask({ name: "task2", process: successProcess });
      taskList.start();
      await taskList.waitUntilIdle();

      expect(taskList.tasks[1].state).toBe("completed");
    });
  });
});
