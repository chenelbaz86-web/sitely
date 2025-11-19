import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const todoTool = createTool({
  id: "update_todo_list",
  description:
    "Use the update todo list tool to keep track of the tasks you need to do to accomplish the user's request. You should should update the todo list each time you complete an item. You can remove tasks from the todo list, but only if they are no longer relevant or you've finished the user's request completely and they are asking for something else. Make sure to update the todo list each time the user asks you do something new. If they're asking for something new, you should probably just clear the whole todo list and start over with new items. For complex logic, use multiple todos to ensure you get it all right rather than just a single todo for implementing all logic.",
  inputSchema: z.object({
    items: z.array(
      z.object({
        description: z.string(),
        completed: z.boolean(),
      })
    ),
  }),
  execute: async ({}) => {
    return {};
  },
});