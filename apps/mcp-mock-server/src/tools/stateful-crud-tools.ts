import { z } from "zod/v3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAgent } from "agents/mcp";
import type { Env } from "../env.ts";

export function registerStatefulCRUDTools(server: McpServer, agent: McpAgent<Env>) {
  agent.sql`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  server.tool(
    "mock_create_note",
    "Create a new note with a title and content",
    {
      title: z.string().describe("The title of the note"),
      content: z.string().describe("The content of the note"),
    },
    async ({ title, content }) => {
      const id = `note-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const timestamp = Date.now();

      agent.sql`
        INSERT INTO notes (id, title, content, created_at, updated_at)
        VALUES (${id}, ${title}, ${content}, ${timestamp}, ${timestamp})
      `;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id,
                title,
                content,
                created_at: timestamp,
                updated_at: timestamp,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool("mock_list_notes", "List all notes in the collection", {}, async () => {
    const notes = agent.sql<{
      id: string;
      title: string;
      content: string;
      created_at: number;
      updated_at: number;
    }>`SELECT * FROM notes ORDER BY created_at DESC`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: notes.length,
              notes,
            },
            null,
            2,
          ),
        },
      ],
    };
  });

  server.tool(
    "mock_get_note",
    "Get a specific note by its ID",
    {
      id: z.string().describe("The ID of the note to retrieve"),
    },
    async ({ id }) => {
      const notes = agent.sql<{
        id: string;
        title: string;
        content: string;
        created_at: number;
        updated_at: number;
      }>`SELECT * FROM notes WHERE id = ${id}`;

      if (notes.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Note not found", id }, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(notes[0], null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "mock_update_note",
    "Update an existing note's title and/or content",
    {
      id: z.string().describe("The ID of the note to update"),
      title: z.string().optional().describe("New title for the note"),
      content: z.string().optional().describe("New content for the note"),
    },
    async ({ id, title, content }) => {
      const existing = agent.sql<{ id: string; title: string; content: string }>`
        SELECT id, title, content FROM notes WHERE id = ${id}
      `;

      if (existing.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Note not found", id }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const newTitle = title ?? existing[0].title;
      const newContent = content ?? existing[0].content;
      const timestamp = Date.now();

      agent.sql`
        UPDATE notes
        SET title = ${newTitle}, content = ${newContent}, updated_at = ${timestamp}
        WHERE id = ${id}
      `;

      const updated = agent.sql<{
        id: string;
        title: string;
        content: string;
        created_at: number;
        updated_at: number;
      }>`SELECT * FROM notes WHERE id = ${id}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(updated[0], null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "mock_delete_note",
    "Delete a note by its ID",
    {
      id: z.string().describe("The ID of the note to delete"),
    },
    async ({ id }) => {
      const existing = agent.sql<{ id: string }>`SELECT id FROM notes WHERE id = ${id}`;

      if (existing.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Note not found", id }, null, 2),
            },
          ],
          isError: true,
        };
      }

      agent.sql`DELETE FROM notes WHERE id = ${id}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, deleted_id: id }, null, 2),
          },
        ],
      };
    },
  );

  server.tool("mock_clear_all_notes", "Delete all notes from the collection", {}, async () => {
    const beforeCount = agent.sql<{ count: number }>`SELECT COUNT(*) as count FROM notes`;

    agent.sql`DELETE FROM notes`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, deleted_count: beforeCount[0].count }, null, 2),
        },
      ],
    };
  });
}
