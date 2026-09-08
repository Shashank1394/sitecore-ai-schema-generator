import "dotenv/config";

import fs from "fs/promises";
import path from "path";

const endpoint = process.env.SITECORE_GRAPHQL_URL;
const token = process.env.SITECORE_TOKEN;

if (!endpoint) {
  throw new Error("SITECORE_GRAPHQL_URL is missing from .env");
}

if (!token) {
  throw new Error("SITECORE_TOKEN is missing from .env");
}

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
  }>;
};

async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(endpoint!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}\n\n${text}`,
    );
  }

  let json: GraphQLResponse<T>;

  try {
    json = JSON.parse(text) as GraphQLResponse<T>;
  } catch {
    throw new Error(`Invalid JSON response:\n\n${text}`);
  }

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("\n"));
  }

  if (!json.data) {
    throw new Error("GraphQL response did not contain data.");
  }

  return json.data;
}

/**
 * Phase 1:
 * Discover only the names/kinds of all types.
 *
 * This is intentionally tiny and avoids newer introspection fields
 * that the SitecoreAI server does not expose.
 */
async function discoverTypes() {
  const query = `
    query BootstrapSchema {
      __schema {
        queryType {
          name
        }
        mutationType {
          name
        }
        types {
          name
          kind
        }
      }
    }
  `;

  return graphqlRequest<{
    __schema: {
      queryType: { name: string } | null;
      mutationType: { name: string } | null;
      types: Array<{
        name: string;
        kind: string;
      }>;
    };
  }>(query);
}

/**
 * Phase 2:
 * Retrieve one type at a time.
 *
 * We deliberately use only introspection fields that your server
 * demonstrably supports.
 */
async function getType(name: string) {
  const query = `
    query InspectType($name: String!) {
      __type(name: $name) {
        name
        kind
        description

        fields {
          name
          description
          args {
            name
            description
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }

        inputFields {
          name
          description
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }

        interfaces {
          name
          kind
        }

        possibleTypes {
          name
          kind
        }

        enumValues {
          name
          description
        }

        ofType {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
  `;

  return graphqlRequest<{
    __type: Record<string, unknown> | null;
  }>(query, { name });
}

async function main() {
  console.log("========================================");
  console.log(" SitecoreAI GraphQL Schema Extractor");
  console.log("========================================\n");

  console.log("Endpoint:");
  console.log(endpoint);

  console.log("\n[1/2] Bootstrapping schema...");

  const bootstrap = await discoverTypes();

  const schema = bootstrap.__schema;

  console.log(`Found ${schema.types.length} GraphQL types.`);

  console.log(`Query root: ${schema.queryType?.name ?? "none"}`);

  console.log(`Mutation root: ${schema.mutationType?.name ?? "none"}`);

  const schemaDir = path.resolve("schema");
  const typesDir = path.join(schemaDir, "types");

  await fs.mkdir(typesDir, { recursive: true });

  /*
   * Save the bootstrap information immediately.
   * If something fails later, we still have useful output.
   */
  await fs.writeFile(
    path.join(schemaDir, "bootstrap.json"),
    JSON.stringify(schema, null, 2),
    "utf8",
  );

  console.log("\n[2/2] Inspecting individual types...\n");

  let completed = 0;

  for (const type of schema.types) {
    if (!type.name) {
      continue;
    }

    completed++;

    process.stdout.write(
      `[${completed}/${schema.types.length}] ${type.name} ... `,
    );

    try {
      const result = await getType(type.name);

      await fs.writeFile(
        path.join(typesDir, `${safeFilename(type.name)}.json`),
        JSON.stringify(result.__type, null, 2),
        "utf8",
      );

      console.log("OK");
    } catch (error) {
      console.log("FAILED");

      if (error instanceof Error) {
        console.error(`   ${error.message}`);
      }
    }
  }

  console.log("\nSchema extraction finished.");

  console.log(`\nOutput:`);
  console.log(`  ${schemaDir}`);
  console.log(`  ${path.join(schemaDir, "bootstrap.json")}`);
  console.log(`  ${typesDir}`);
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

main().catch((error: unknown) => {
  console.error("\nSchema extraction failed.\n");

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }

  process.exit(1);
});
