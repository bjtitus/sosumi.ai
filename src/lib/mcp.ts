import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { fetchJSONData } from "./fetch"
import { renderFromJSON } from "./render"
import { searchAppleDeveloperDocs } from "./search"
import { generateAppleDocUrl, normalizeDocumentationPath } from "./url"

export function createMcpServer() {
  const server = new McpServer({
    name: "sosumi.ai",
    version: "1.0.0",
  })

  // Register doc://{path} resource template
  server.registerResource(
    "documentation",
    new ResourceTemplate("doc://{path}", { 
      list: undefined,
      complete: {
        path: async (value) => {
          try {
            // Add timeout to prevent hanging
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Completion timeout')), 3000)
            })
            
            const searchPromise = searchAppleDeveloperDocs(value)
            const searchResponse = await Promise.race([searchPromise, timeoutPromise])
            
            const completions = searchResponse.results
              .map(result => {
                try {
                  const url = new URL(result.url)
                  // More robust path extraction
                  let path = url.pathname
                  if (path.startsWith('/documentation/')) {
                    path = path.replace('/documentation/', '')
                  } else if (path.startsWith('/')) {
                    path = path.substring(1)
                  }
                  return { path, title: result.title }
                } catch {
                  return { path: '', title: result.title || '' }
                }
              })
              .filter(({ path, title }) => {
                if (!path) return false
                
                const lowerValue = value.toLowerCase()
                const lowerPath = path.toLowerCase()
                const lowerTitle = title.toLowerCase()
                
                // Exact prefix match (highest priority)
                if (lowerPath.startsWith(lowerValue)) return true
                
                // Fuzzy path matching - check if all parts of value appear in path
                const valueParts = lowerValue.split(/[\/\-_\s]+/).filter(p => p.length > 0)
                const pathParts = lowerPath.split(/[\/\-_\s]+/)
                
                // Check if all value parts can be found in path parts (in order)
                let pathIndex = 0
                for (const valuePart of valueParts) {
                  let found = false
                  for (let i = pathIndex; i < pathParts.length; i++) {
                    if (pathParts[i].includes(valuePart)) {
                      pathIndex = i + 1
                      found = true
                      break
                    }
                  }
                  if (!found) return false
                }
                
                return true
              })
              .map(({ path }) => path)
              .slice(0, 8) // Limit to 8 completions for better performance
            
            return completions
          } catch (error) {
            console.error('Completion error:', error)
            return []
          }
        }
      }
    }),
    {
      title: "Apple Documentation",
      description: "Apple Developer documentation as Markdown",
    },
    async (uri, { path }) => {
      try {
        // Percent decode the path first, then generate URL
        const decodedPath = decodeURIComponent(path.toString())
        const normalizedPath = normalizeDocumentationPath(decodedPath)
        const appleUrl = generateAppleDocUrl(normalizedPath)

        const jsonData = await fetchJSONData(normalizedPath)
        const markdown = await renderFromJSON(jsonData, appleUrl)

        if (!markdown || markdown.trim().length < 100) {
          throw new Error("Insufficient content in documentation")
        }

        return {
          contents: [
            {
              uri: uri.href,
              text: markdown,
              mimeType: "text/markdown",
            },
          ],
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        return {
          contents: [
            {
              uri: uri.href,
              text: `Error fetching documentation: ${errorMessage}`,
              mimeType: "text/plain",
            },
          ],
        }
      }
    },
  )

  // Register Apple search tool
  server.registerTool(
    "search",
    {
      title: "Search Apple Documentation",
      description: "Search Apple Developer documentation and return structured results",
      inputSchema: {
        query: z.string().describe("Search query for Apple documentation"),
      },
      outputSchema: {
        query: z.string().describe("The search query that was executed"),
        results: z
          .array(
            z.object({
              title: z.string().describe("Title of the documentation page"),
              url: z.string().describe("Full URL to the documentation page"),
              description: z.string().describe("Brief description of the page content"),
              breadcrumbs: z
                .array(z.string())
                .describe("Navigation breadcrumbs showing the page hierarchy"),
              tags: z
                .array(z.string())
                .describe("Tags associated with the page (languages, platforms, etc.)"),
              type: z.string().describe("Type of result (documentation, general, etc.)"),
            }),
          )
          .describe("Array of search results"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      try {
        const searchResponse = await searchAppleDeveloperDocs(query)

        const structuredContent = {
          query: searchResponse.query,
          results: searchResponse.results.map((result) => ({
            title: result.title,
            url: result.url,
            description: result.description,
            breadcrumbs: result.breadcrumbs,
            tags: result.tags,
            type: result.type,
          })),
        }

        if (searchResponse.results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}"`,
              },
            ],
            structuredContent,
          }
        }

        // Provide a readable text summary
        const resultText =
          `Found ${searchResponse.results.length} result(s) for "${query}":\n\n` +
          searchResponse.results
            .map(
              (result, index) =>
                `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.description || "No description"}`,
            )
            .join("\n\n")

        return {
          content: [
            {
              type: "text" as const,
              text: resultText,
            },
          ],
          structuredContent,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"

        const structuredContent = {
          query,
          results: [],
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching Apple Developer documentation: ${errorMessage}`,
            },
          ],
          structuredContent,
        }
      }
    },
  )

  // Register documentation fetch tool (complements resource template for tool-only clients)
  server.registerTool(
    "fetch",
    {
      title: "Fetch Apple Documentation",
      description: "Fetch Apple Developer documentation by path and return as markdown",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Full or relative documentation path (e.g., '/documentation/swift', 'swiftui/view')",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path }) => {
      try {
        // Generate Apple Developer URL (path normalization handled by fetchJSONData)
        const normalizedPath = normalizeDocumentationPath(path)
        const appleUrl = generateAppleDocUrl(normalizedPath)

        const jsonData = await fetchJSONData(normalizedPath)
        const markdown = await renderFromJSON(jsonData, appleUrl)

        if (!markdown || markdown.trim().length < 100) {
          throw new Error("Insufficient content in documentation")
        }

        return {
          content: [
            {
              type: "text" as const,
              text: markdown,
            },
          ],
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"

        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching documentation for "${path}": ${errorMessage}`,
            },
          ],
        }
      }
    },
  )

  return server
}
