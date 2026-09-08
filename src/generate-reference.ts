import fs from "fs/promises";
import path from "path";

type TypeRef = {
  kind?: string | null;
  name?: string | null;
  ofType?: TypeRef | null;
};

type ArgumentDefinition = {
  name: string;
  description?: string | null;
  type?: TypeRef | null;
};

type FieldDefinition = {
  name: string;
  description?: string | null;
  args?: ArgumentDefinition[] | null;
  type?: TypeRef | null;
};

type EnumValue = {
  name: string;
  description?: string | null;
};

type GraphQLType = {
  name: string;
  kind: string;
  description?: string | null;

  fields?: FieldDefinition[] | null;

  inputFields?: FieldDefinition[] | null;

  interfaces?: TypeRef[] | null;

  possibleTypes?: TypeRef[] | null;

  enumValues?: EnumValue[] | null;

  ofType?: TypeRef | null;
};

type Bootstrap = {
  queryType?: {
    name: string;
  } | null;

  mutationType?: {
    name: string;
  } | null;

  types: Array<{
    name: string;
    kind: string;
  }>;
};

type OperationReference = {
  operation: string;
  operationType: "query" | "mutation";
  rootType: string;
  description: string | null;

  arguments: NormalizedArgument[];
  returnType: NormalizedTypeReference;
  inputDependencyGraph: TypeDependencyGraph;
  returnDependencyGraph: TypeDependencyGraph;

  metadata: {
    generatedFrom: string;
  };
};

type NormalizedTypeReference = {
  display: string;
  namedTypes: string[];
  required: boolean;
};

type NormalizedArgument = {
  name: string;
  description: string | null;
  type: NormalizedTypeReference;
  required: boolean;
};

type TypeDependencyGraph = {
  root: NormalizedTypeReference;
  roots: NormalizedTypeReference[];
  nodes: Record<string, NormalizedType & { file: string; dependencies: string[] }>;
};

type NormalizedType = {
  name: string;
  kind: string;
  description: string | null;
  fields: Array<{
    name: string;
    description: string | null;
    type: NormalizedTypeReference;
    arguments: NormalizedArgument[];
  }>;
  inputFields: Array<{
    name: string;
    description: string | null;
    type: NormalizedTypeReference;
  }>;
  interfaces: string[];
  possibleTypes: string[];
  enumValues: Array<{ name: string; description: string | null }>;
  metadata: { generatedFrom: string };
};

const projectRoot = path.resolve(".");

const schemaDir = path.join(projectRoot, "schema");

const typesDir = path.join(schemaDir, "types");

const referenceDir = path.join(projectRoot, "reference");

const queriesDir = path.join(referenceDir, "queries");

const mutationsDir = path.join(referenceDir, "mutations");

const normalizedTypesDir = path.join(referenceDir, "types");

async function readJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");

  return JSON.parse(content) as T;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Converts a GraphQL type reference into a readable
 * GraphQL type string.
 *
 * Examples:
 * String
 * String!
 * [String]
 * [String!]!
 */
function unwrapType(type: TypeRef | null | undefined): string {
  if (!type) {
    return "UNKNOWN";
  }

  switch (type.kind) {
    case "NON_NULL":
      return type.ofType ? `${unwrapType(type.ofType)}!` : "UNKNOWN!";

    case "LIST":
      return type.ofType ? `[${unwrapType(type.ofType)}]` : "[UNKNOWN]";

    default:
      return type.name ?? type.kind ?? "UNKNOWN";
  }
}

/**
 * Extracts every named type from a potentially nested
 * GraphQL type reference.
 */
function collectNamedTypes(
  type: TypeRef | null | undefined,
  result: Set<string>,
): void {
  if (!type) {
    return;
  }

  if (type.kind === "NON_NULL" || type.kind === "LIST") {
    collectNamedTypes(type.ofType, result);

    return;
  }

  if (type.name) {
    result.add(type.name);
  }
}

function normalizeTypeReference(
  type: TypeRef | null | undefined,
): NormalizedTypeReference {
  const namedTypes = new Set<string>();

  collectNamedTypes(type, namedTypes);

  return {
    display: unwrapType(type),
    namedTypes: [...namedTypes],
    required: type?.kind === "NON_NULL",
  };
}

function normalizeArgument(argument: ArgumentDefinition): NormalizedArgument {
  return {
    name: argument.name,
    description: argument.description ?? null,
    type: normalizeTypeReference(argument.type),
    required: argument.type?.kind === "NON_NULL",
  };
}

function typeReferenceFile(typeName: string): string {
  // Reference documents are data exchanged with tools and LLMs, so retain
  // portable POSIX separators even when generation runs on Windows.
  return `types/${safeFilename(typeName)}.json`;
}

async function loadType(typeName: string): Promise<GraphQLType | null> {
  const filePath = path.join(typesDir, `${safeFilename(typeName)}.json`);

  try {
    const raw = await readJson<GraphQLType | { __type?: GraphQLType | null }>(
      filePath,
    );

    // Step 1 stores individual type responses as:
    // {
    //   "__type": {
    //     "name": "...",
    //     "kind": "...",
    //     ...
    //   }
    // }
    //
    // Extract the actual type definition.
    if (typeof raw === "object" && raw !== null && "__type" in raw) {
      return raw.__type ?? null;
    }

    // Also support an already-unwrapped type file.
    return raw as GraphQLType;
  } catch {
    return null;
  }
}

function normalizeTypeDefinition(definition: GraphQLType): NormalizedType {
  return {
    name: definition.name,
    kind: definition.kind,
    description: definition.description ?? null,
    fields: (definition.fields ?? []).map((field) => ({
      name: field.name,
      description: field.description ?? null,
      type: normalizeTypeReference(field.type),
      arguments: (field.args ?? []).map(normalizeArgument),
    })),
    inputFields: (definition.inputFields ?? []).map((field) => ({
      name: field.name,
      description: field.description ?? null,
      type: normalizeTypeReference(field.type),
    })),
    interfaces: (definition.interfaces ?? [])
      .flatMap((reference) => normalizeTypeReference(reference).namedTypes),
    possibleTypes: (definition.possibleTypes ?? [])
      .flatMap((reference) => normalizeTypeReference(reference).namedTypes),
    enumValues: (definition.enumValues ?? []).map((value) => ({
      name: value.name,
      description: value.description ?? null,
    })),
    metadata: {
      generatedFrom: "SitecoreAI GraphQL introspection",
    },
  };
}

/**
 * Write one normalized, self-contained document for every named type returned
 * by introspection. These documents are the canonical schema library; root
 * operation files reference them instead of flattening schema definitions.
 */
async function generateNormalizedTypes(
  bootstrap: Bootstrap,
): Promise<Array<{ name: string; kind: string; file: string }>> {
  await fs.mkdir(normalizedTypesDir, { recursive: true });

  const output: Array<{ name: string; kind: string; file: string }> = [];

  for (const type of bootstrap.types) {
    const definition = await loadType(type.name);

    if (!definition) {
      throw new Error(`Could not find schema/types/${type.name}.json`);
    }

    const normalized = normalizeTypeDefinition(definition);

    const file = typeReferenceFile(definition.name);

    await fs.writeFile(
      path.join(referenceDir, file),
      JSON.stringify(normalized, null, 2),
      "utf8",
    );

    output.push({ name: definition.name, kind: definition.kind, file });
  }

  return output;
}

/**
 * Construct a complete, cycle-safe dependency graph rooted at a type
 * reference. Every node preserves its complete extracted definition, while
 * `dependencies` provides the explicit graph edges for efficient traversal.
 */
async function buildDependencyGraph(
  root: TypeRef | null | undefined,
): Promise<TypeDependencyGraph> {
  const nodes: TypeDependencyGraph["nodes"] = {};
  const visited = new Set<string>();

  async function visit(reference: TypeRef | null | undefined): Promise<void> {
    const names = new Set<string>();
    collectNamedTypes(reference, names);

    for (const name of names) {
      if (visited.has(name)) {
        continue;
      }

      visited.add(name);

      const definition = await loadType(name);

      if (!definition) {
        throw new Error(`Could not find schema/types/${name}.json`);
      }

      const normalized = normalizeTypeDefinition(definition);
      const dependencies = new Set<string>();

      for (const field of normalized.fields) {
        for (const dependency of field.type.namedTypes) {
          dependencies.add(dependency);
        }

        for (const argument of field.arguments) {
          for (const dependency of argument.type.namedTypes) {
            dependencies.add(dependency);
          }
        }
      }

      for (const field of normalized.inputFields) {
        for (const dependency of field.type.namedTypes) {
          dependencies.add(dependency);
        }
      }

      for (const dependency of [...normalized.interfaces, ...normalized.possibleTypes]) {
        dependencies.add(dependency);
      }

      nodes[name] = {
        ...normalized,
        file: typeReferenceFile(name),
        dependencies: [...dependencies],
      };

      for (const dependency of dependencies) {
        await visit({ name: dependency });
      }
    }
  }

  await visit(root);

  return {
    root: normalizeTypeReference(root),
    roots: [normalizeTypeReference(root)],
    nodes,
  };
}

/**
 * Build one complete operation reference.
 */
async function buildOperationReference(
  rootTypeName: string,
  operationType: "query" | "mutation",
  operation: FieldDefinition,
): Promise<OperationReference> {
  const inputGraphs = await Promise.all(
    (operation.args ?? []).map((argument) => buildDependencyGraph(argument.type)),
  );
  const inputDependencyGraph: TypeDependencyGraph = {
    root: inputGraphs[0]?.root ?? normalizeTypeReference(null),
    roots: inputGraphs.flatMap((graph) => graph.roots),
    nodes: Object.assign({}, ...inputGraphs.map((graph) => graph.nodes)),
  };
  const returnDependencyGraph = await buildDependencyGraph(operation.type);

  return {
    operation: operation.name,

    operationType,

    rootType: rootTypeName,

    description: operation.description ?? null,

    arguments: (operation.args ?? []).map(normalizeArgument),

    returnType: normalizeTypeReference(operation.type),

    inputDependencyGraph,

    returnDependencyGraph,

    metadata: {
      generatedFrom: "SitecoreAI GraphQL introspection",
    },
  };
}

/**
 * Generate all root-level operations for
 * either Query or Mutation.
 */
async function generateRootOperations(
  rootTypeName: string,
  operationType: "query" | "mutation",
): Promise<
  Array<{
    operation: string;
    type: "query" | "mutation";
    file: string;
  }>
> {
  const rootType = await loadType(rootTypeName);

  if (!rootType) {
    throw new Error(`Could not find schema/types/${rootTypeName}.json`);
  }

  if (rootType.kind !== "OBJECT") {
    throw new Error(`${rootTypeName} is not an OBJECT type.`);
  }

  const operations = rootType.fields ?? [];

  const destination = operationType === "query" ? queriesDir : mutationsDir;

  await fs.mkdir(destination, {
    recursive: true,
  });

  const output: Array<{
    operation: string;
    type: "query" | "mutation";
    file: string;
  }> = [];

  for (const operation of operations) {
    console.log(`  Generating ${operationType}: ${operation.name}`);

    const reference = await buildOperationReference(
      rootTypeName,
      operationType,
      operation,
    );

    const fileName = `${safeFilename(operation.name)}.json`;

    const filePath = path.join(destination, fileName);

    await fs.writeFile(filePath, JSON.stringify(reference, null, 2), "utf8");

    output.push({
      operation: operation.name,
      type: operationType,
      file: `${operationType === "query" ? "queries" : "mutations"}/${fileName}`,
    });
  }

  return output;
}

async function main(): Promise<void> {
  console.log("========================================");

  console.log(" SitecoreAI Reference Generator");

  console.log("========================================\n");

  /*
   * Load the bootstrap generated by Step 1.
   */
  const bootstrap = await readJson<Bootstrap>(
    path.join(schemaDir, "bootstrap.json"),
  );

  console.log(`Schema contains ${bootstrap.types.length} types.`);

  /*
   * Start with a clean reference directory.
   */
  await fs.rm(referenceDir, {
    recursive: true,
    force: true,
  });

  await fs.mkdir(queriesDir, {
    recursive: true,
  });

  await fs.mkdir(mutationsDir, {
    recursive: true,
  });

  await fs.mkdir(normalizedTypesDir, {
    recursive: true,
  });

  type OperationIndexEntry = {
    operation: string;
    type: "query" | "mutation";
    file: string;
  };

  type TypeIndexEntry = {
    name: string;
    kind: string;
    file: string;
  };

  const index: {
    generatedAt: string;

    schema: {
      queryRoot: string | null;
      mutationRoot: string | null;
      typeCount: number;
    };

    queries: OperationIndexEntry[];
    mutations: OperationIndexEntry[];
    types: TypeIndexEntry[];
  } = {
    generatedAt: new Date().toISOString(),

    schema: {
      queryRoot: bootstrap.queryType?.name ?? null,

      mutationRoot: bootstrap.mutationType?.name ?? null,

      typeCount: bootstrap.types.length,
    },

    queries: [],

    mutations: [],

    types: [],
  };

  await fs.writeFile(
    path.join(referenceDir, "index.json"),
    JSON.stringify(index, null, 2),
    "utf8",
  );

  console.log("\nGenerating normalized type library...");

  index.types = await generateNormalizedTypes(bootstrap);

  /* Generate operations from the schema roots, when present. */
  if (bootstrap.queryType?.name) {
    index.queries = await generateRootOperations(
      bootstrap.queryType.name,
      "query",
    );
  }

  if (bootstrap.mutationType?.name) {
    index.mutations = await generateRootOperations(
      bootstrap.mutationType.name,
      "mutation",
    );
  }

  /*
   * Persist the populated index after all operation files have been written.
   */
  await fs.writeFile(
    path.join(referenceDir, "index.json"),
    JSON.stringify(index, null, 2),
    "utf8",
  );

  console.log("\n========================================");

  console.log(" Reference generation successful");

  console.log("========================================");

  console.log(`\nQueries generated: ${index.queries.length}`);

  console.log(`Mutations generated: ${index.mutations.length}`);

  console.log(`Types normalized: ${index.types.length}`);

  console.log(`\nReference directory:`);

  console.log(referenceDir);
}

main().catch((error: unknown) => {
  console.error("\nReference generation failed.\n");

  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(error);
  }

  process.exit(1);
});
