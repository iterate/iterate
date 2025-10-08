---
description: "Use of useEffect"
globs: ["**/*.tsx"]
---

- Strongly prefer not to use the react useEffect hook unless there is NO other choice. It is error prone and hard to reason about.
- If you need to calculate something during render, just do it in the render function.
- If you want to fetch data, use a useQuery hook.
- If you want to do something in response to an event, do it in the event handler.
- Use a key if you want to reset state.
- Use syncExternalStore if you want to synchronize with an external store.
- Whenever you try to synchronize state variables in different components, consider lifting state up.
- You do need Effects to synchronize with external systems. For example, you can write an Effect that keeps a jQuery widget synchronized with the React state. You can also fetch data with Effects: for example, you can synchronize the search results with the current search query.
