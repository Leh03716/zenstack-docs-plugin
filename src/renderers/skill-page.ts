import {
  extractProcedureComments,
  formatAttrArgs as formatAttributeArgs,
  getAttrName as getAttributeName,
  resolveTypeName,
  stripCommentPrefix,
} from '../extractors';
import {
  type Relationship,
  type RelationType,
  type SkillPageProps,
} from '../types';
import { relationDedupKey, relationToMermaid } from './erd';
import {
  type DataField,
  type DataModel,
  type Enum,
  isDataModel,
  type Procedure,
  type TypeDef,
} from '@zenstackhq/language/ast';
import { getAllFields } from '@zenstackhq/language/utils';

type SkillCounts = {
  enums: number;
  models: number;
  procedures: number;
  types: number;
  views: number;
};

/**
 * Renders a `SKILL.md` file — an AI-agent-readable schema reference designed for
 * use as a skill definition in tools like Cursor, Claude Code, and skills.sh.
 *
 * The output includes a schema overview, detected conventions, access/validation constraints,
 * workflow guidance, and a full entity reference with prisma declaration blocks.
 */
export function renderSkillPage(props: SkillPageProps): string {
  const {
    enums,
    hasRelationships,
    models,
    procedures,
    relations,
    title,
    typeDefs,
    views,
  } = props;
  const counts: SkillCounts = {
    enums: enums.length,
    models: models.length,
    procedures: procedures.length,
    types: typeDefs.length,
    views: views.length,
  };

  return [
    ...renderFrontmatter(title),
    ...renderOverview(title, counts, models, views),
    ...renderRelationshipMap(relations),
    ...renderRelationshipsTable(relations),
    ...renderConventions(models, typeDefs),
    ...renderPolicyMatrix(models),
    ...renderConstraints(models),
    ...renderWorkflow(models, procedures, relations, hasRelationships),
    ...renderEntityReference(models, enums, typeDefs, views),
    ...renderFooter(hasRelationships),
  ].join('\n');
}

/**
 * Finds all `@computed` fields across models for the conventions section.
 */
function detectComputedFields(models: DataModel[]): string[] {
  const computed: string[] = [];
  for (const m of models) {
    for (const f of getAllFields(m, true)) {
      if (f.attributes.some((a) => getAttributeName(a) === '@computed')) {
        const desc = f.comments ? stripCommentPrefix(f.comments) : '';
        const descPart = desc ? ` — ${desc}` : '';
        computed.push(`- ${m.name}.${f.name}${descPart}`);
      }
    }
  }

  return computed;
}

/**
 * Extracts example foreign key field names from `@relation` attributes across models.
 */
function detectFKExamples(models: DataModel[]): string[] {
  const fks: string[] = [];
  for (const m of models) {
    for (const f of getAllFields(m, true)) {
      if (!(f.type.reference?.ref && isDataModel(f.type.reference.ref))) {
        continue;
      }

      if (f.type.array) {
        continue;
      }

      const relAttribute = f.attributes.find(
        (a) => getAttributeName(a) === '@relation',
      );
      if (!relAttribute) {
        continue;
      }

      const fieldsArgument = relAttribute.args.find((a) => {
        const argText = a.$cstNode?.text ?? '';
        return argText.includes('fields:') || argText.startsWith('[');
      });
      if (!fieldsArgument) {
        continue;
      }

      const text = fieldsArgument.$cstNode?.text ?? '';
      const bracketMatch = text.match(/\[([^\]]+)\]/u);
      if (!bracketMatch) {
        continue;
      }

      for (const fk of bracketMatch[1]!.split(',').map((s) => s.trim())) {
        if (fk && !fks.includes(fk)) {
          fks.push(fk);
        }
      }
    }
  }

  return fks;
}

/**
 * Analyzes `@id` + `@default` patterns across models to describe the ID generation convention.
 */
function detectIdConvention(models: DataModel[]): string {
  const defaults = new Map<string, number>();
  for (const m of models) {
    for (const f of m.fields) {
      const isId = f.attributes.some((a) => getAttributeName(a) === '@id');
      if (!isId) {
        continue;
      }

      const defaultAttribute = f.attributes.find(
        (a) => getAttributeName(a) === '@default',
      );
      const value = defaultAttribute?.args[0]?.$cstNode?.text ?? 'none';
      defaults.set(value, (defaults.get(value) ?? 0) + 1);
    }
  }

  if (defaults.size === 0) {
    return 'No consistent ID convention detected.';
  }

  const sorted = [...defaults.entries()].sort((a, b) => b[1] - a[1]);
  const [primary, count] = sorted[0]!;
  if (count === models.length) {
    return `All models use \`@default(${primary})\` for IDs.`;
  }

  const exceptions = sorted
    .slice(1)
    .map(([function_, c]) => `${c} use \`${function_}\``)
    .join(', ');
  return `Most models use \`@default(${primary})\` for IDs. Exceptions: ${exceptions}.`;
}

/**
 * Lists which type definitions are used as mixins and by which models.
 */
function detectMixins(models: DataModel[], typeDefs: TypeDef[]): string[] {
  if (typeDefs.length === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const td of typeDefs) {
    const users = models.filter((m) =>
      m.mixins.some((mx) => mx.ref?.name === td.name),
    );
    if (users.length > 0) {
      const fieldNames = td.fields.map((f) => `\`${f.name}\``).join(', ');
      lines.push(
        `- **${td.name}** (${fieldNames}) — used by ${users.map((u) => u.name).join(', ')}`,
      );
    }
  }

  return lines;
}

/**
 * Formats a single field as a Prisma-style declaration line with type and attributes.
 */
function fieldDeclarationLine(field: DataField): string {
  let typeName = resolveTypeName(field.type);
  if (field.type.array) {
    typeName += '[]';
  }

  if (field.type.optional) {
    typeName += '?';
  }

  const attributes = (field.attributes ?? [])
    .filter((a) => {
      const name = getAttributeName(a);
      return name && !name.startsWith('@@@') && name !== '@meta';
    })
    .map((a) => `${getAttributeName(a)}${formatAttributeArgs(a)}`)
    .join(' ');

  const attributePart = attributes ? ` ${attributes}` : '';
  return `    ${field.name} ${typeName}${attributePart}`;
}

/**
 * Joins non-zero entity counts into a comma-separated summary string.
 */
function formatCountSummary(counts: SkillCounts): string {
  const parts: string[] = [];
  if (counts.models > 0) {
    parts.push(plural(counts.models, 'model'));
  }

  if (counts.views > 0) {
    parts.push(plural(counts.views, 'view'));
  }

  if (counts.types > 0) {
    parts.push(plural(counts.types, 'type'));
  }

  if (counts.enums > 0) {
    parts.push(plural(counts.enums, 'enum'));
  }

  if (counts.procedures > 0) {
    parts.push(plural(counts.procedures, 'procedure'));
  }

  return parts.join(', ');
}

/**
 * Returns true if any model's access policy references `auth()`.
 */
function hasAuthRules(models: DataModel[]): boolean {
  return models.some((m) =>
    m.attributes.some((a) => {
      const name = a.decl.ref?.name;
      if (name !== '@@allow' && name !== '@@deny') {
        return false;
      }

      return a.args.some((argument) =>
        argument.$cstNode?.text?.includes('auth()'),
      );
    }),
  );
}

/**
 * Returns a pluralized count string (e.g. "3 models", "1 view").
 */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Renders validation rules that agents must respect.
 */
function renderConstraints(models: DataModel[]): string[] {
  const validationEntries: Array<{
    field: string;
    model: string;
    rule: string;
  }> = [];
  for (const model of models) {
    for (const field of getAllFields(model, true)) {
      for (const attribute of field.attributes) {
        const attributeDecl = attribute.decl.ref;
        if (!attributeDecl) {
          continue;
        }

        if (
          attributeDecl.attributes.some(
            (ia) => ia.decl.ref?.name === '@@@validation',
          )
        ) {
          validationEntries.push({
            field: field.name,
            model: model.name,
            rule: `${getAttributeName(attribute)}${formatAttributeArgs(attribute)}`,
          });
        }
      }
    }
  }

  if (validationEntries.length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push('## Validation');
  lines.push('');
  lines.push(
    'These constraints are enforced at the schema level. When generating test data, seed scripts, or form inputs, produce values that satisfy them.',
  );
  lines.push('');

  const byModel = new Map<string, Array<{ field: string; rule: string }>>();
  for (const entry of validationEntries) {
    const list = byModel.get(entry.model) ?? [];
    list.push({ field: entry.field, rule: entry.rule });
    byModel.set(entry.model, list);
  }

  for (const modelName of [...byModel.keys()].sort()) {
    const rules = byModel
      .get(modelName)!
      .map((r) => `${r.field}: ${r.rule}`)
      .join(', ');
    lines.push(`- **${modelName}**: ${rules}`);
  }

  lines.push('');
  return lines;
}

/**
 * Renders detected schema conventions: ID strategy, mixins, computed fields, FK patterns.
 */
function renderConventions(models: DataModel[], typeDefs: TypeDef[]): string[] {
  const lines: string[] = [];
  lines.push('## Conventions');
  lines.push('');
  lines.push('Follow these patterns when working with this schema:');
  lines.push('');

  lines.push(`- **IDs**: ${detectIdConvention(models)}`);

  const mixinLines = detectMixins(models, typeDefs);
  if (mixinLines.length > 0) {
    lines.push('- **Mixins** (shared field sets applied via `with`):');
    for (const ml of mixinLines) {
      lines.push(`  ${ml}`);
    }
  }

  const computedFields = detectComputedFields(models);
  if (computedFields.length > 0) {
    lines.push(
      '- **Computed fields** are read-only and derived at the database level. Never set them directly:',
    );
    for (const cf of computedFields) {
      lines.push(`  ${cf}`);
    }
  }

  const modelsWithRelations = models.filter((m) =>
    m.fields.some(
      (f) => f.type.reference?.ref && isDataModel(f.type.reference.ref),
    ),
  );
  if (modelsWithRelations.length > 0) {
    const fkExamples = detectFKExamples(models);
    const fkExamplePart =
      fkExamples.length > 0
        ? ` (e.g. \`${fkExamples.slice(0, 3).join('`, `')}\`)`
        : '';
    lines.push(
      `- **Relations**: ${modelsWithRelations.length} of ${models.length} models have relationships. When creating records, always provide required foreign key fields${fkExamplePart}.`,
    );
  }

  lines.push('');
  return lines;
}

/**
 * Renders the full entity reference with Prisma declaration blocks and doc page links.
 */
function renderEntityReference(
  models: DataModel[],
  enums: Enum[],
  typeDefs: TypeDef[],
  views: DataModel[],
): string[] {
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('## Entity Reference');
  lines.push('');

  if (models.length > 0) {
    lines.push('### Models');
    lines.push('');
    for (const model of [...models].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      lines.push(`#### ${model.name}`);
      lines.push('');
      lines.push('```prisma');
      lines.push(...renderModelDeclaration(model, 'model'));
      lines.push('```');
      lines.push('');
      lines.push(...renderFieldSummary(model));

      lines.push(`[${model.name} (Model)](./models/${model.name}.md)`);
      lines.push('');
    }
  }

  if (enums.length > 0) {
    lines.push('### Enums');
    lines.push('');
    for (const e of [...enums].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`#### ${e.name}`);
      lines.push('');
      lines.push('```prisma');
      lines.push(...renderEnumDeclaration(e));
      lines.push('```');
      lines.push('');
      lines.push(`[${e.name} (Enum)](./enums/${e.name}.md)`);
      lines.push('');
    }
  }

  if (typeDefs.length > 0) {
    lines.push('### Types');
    lines.push('');
    for (const td of [...typeDefs].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      lines.push(`#### ${td.name}`);
      lines.push('');
      lines.push('```prisma');
      lines.push(...renderTypeDeclaration(td));
      lines.push('```');
      lines.push('');
      lines.push(`[${td.name} (Type)](./types/${td.name}.md)`);
      lines.push('');
    }
  }

  if (views.length > 0) {
    lines.push('### Views');
    lines.push('');
    for (const view of [...views].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      lines.push(`#### ${view.name}`);
      lines.push('');
      lines.push('```prisma');
      lines.push(...renderModelDeclaration(view, 'view'));
      lines.push('```');
      lines.push('');
      lines.push(`[${view.name} (View)](./views/${view.name}.md)`);
      lines.push('');
    }
  }

  return lines;
}

/**
 * Renders an enum declaration block with doc comments and values.
 */
function renderEnumDeclaration(e: Enum): string[] {
  const lines: string[] = [];
  const desc = stripCommentPrefix(e.comments);
  if (desc) {
    for (const dLine of desc.split('\n')) {
      lines.push(`/// ${dLine}`);
    }
  }

  lines.push(`enum ${e.name} {`);
  for (const field of e.fields) {
    const valueDesc = stripCommentPrefix(field.comments);
    if (valueDesc) {
      lines.push(`    /// ${valueDesc}`);
    }

    lines.push(`    ${field.name}`);
  }

  lines.push('}');
  return lines;
}

/**
 * Renders a compact field summary listing required, optional, auto-generated, and unique fields.
 */
function renderFieldSummary(model: DataModel): string[] {
  const allFields = getAllFields(model, true);
  const required: string[] = [];
  const optional: string[] = [];
  const autoGenerated: string[] = [];
  const unique: string[] = [];

  for (const field of allFields) {
    if (field.type.reference?.ref && isDataModel(field.type.reference.ref)) {
      continue;
    }

    const typeName = resolveTypeName(field.type);
    const hasDefault = field.attributes.some(
      (a) => getAttributeName(a) === '@default',
    );
    const hasUpdatedAt = field.attributes.some(
      (a) => getAttributeName(a) === '@updatedAt',
    );
    const hasComputed = field.attributes.some(
      (a) => getAttributeName(a) === '@computed',
    );
    const hasId = field.attributes.some((a) => getAttributeName(a) === '@id');
    const hasUnique = field.attributes.some(
      (a) => getAttributeName(a) === '@unique',
    );

    if (hasDefault || hasUpdatedAt || hasComputed) {
      const defaultAttribute = field.attributes.find(
        (a) => getAttributeName(a) === '@default',
      );
      const annotation = hasComputed
        ? '@computed'
        : hasUpdatedAt
          ? '@updatedAt'
          : `@default(${defaultAttribute?.args[0]?.$cstNode?.text ?? ''})`;
      autoGenerated.push(`\`${field.name}\` (${annotation})`);
    } else if (field.type.optional) {
      optional.push(`\`${field.name}\` (${typeName}?)`);
    } else if (!hasId) {
      required.push(`\`${field.name}\` (${typeName})`);
    }

    if (hasUnique) {
      unique.push(`\`${field.name}\``);
    }
  }

  const lines: string[] = [];
  if (required.length > 0) {
    lines.push(`Required fields: ${required.join(', ')}`);
  }

  if (optional.length > 0) {
    lines.push(`Optional fields: ${optional.join(', ')}`);
  }

  if (autoGenerated.length > 0) {
    lines.push(`Auto-generated: ${autoGenerated.join(', ')}`);
  }

  if (unique.length > 0) {
    lines.push(`Unique constraints: ${unique.join(', ')}`);
  }

  if (lines.length > 0) {
    lines.push('');
  }

  return lines;
}

/**
 * Renders the footer with links to the full index and relationships pages.
 */
function renderFooter(hasRelationships: boolean): string[] {
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('## Detailed Documentation');
  lines.push('');
  lines.push(
    'For Mermaid diagrams, formatted tables, and fully cross-linked pages:',
  );
  lines.push('');
  lines.push('- [Full schema index](./index.md)');
  if (hasRelationships) {
    lines.push('- [Relationships and ER diagrams](./relationships.md)');
  }

  lines.push('');
  return lines;
}

/**
 * Renders YAML frontmatter with the skill name and description.
 */
function renderFrontmatter(title: string): string[] {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^\da-z]+/gu, '-')
    .replaceAll(/^-|-$/gu, '');
  return [
    '---',
    `name: ${slug}-schema`,
    `description: Schema reference for ${title}. Use when writing queries, building forms, creating or modifying models, generating API endpoints, writing tests with seed data, or reasoning about data access and validation in this project.`,
    '---',
    '',
  ];
}

/**
 * Generates Prisma-style include patterns from One→Many and Many→Many relationships.
 */
function renderIncludePatterns(relations: Relationship[]): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();

  for (const rel of relations) {
    if (rel.type !== 'One\u2192Many' && rel.type !== 'Many\u2192Many') {
      continue;
    }

    const key = `${rel.from}.${rel.field}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    patterns.push(
      `- \`${rel.from}\` with \`${rel.to}\`: \`include: { ${rel.field}: true }\``,
    );
  }

  return patterns.slice(0, 8);
}

/**
 * Renders a complete model/view declaration block with comments, fields, and attributes.
 */
function renderModelDeclaration(
  model: DataModel,
  keyword: 'model' | 'view',
): string[] {
  const lines: string[] = [];
  const desc = stripCommentPrefix(model.comments);
  if (desc) {
    for (const dLine of desc.split('\n')) {
      lines.push(`/// ${dLine}`);
    }
  }

  const mixinPart =
    model.mixins.length > 0
      ? ` with ${model.mixins
          .map((m) => m.ref?.name ?? '')
          .filter(Boolean)
          .join(', ')}`
      : '';

  lines.push(`${keyword} ${model.name}${mixinPart} {`);
  for (const field of getAllFields(model, true)) {
    const fieldDesc = stripCommentPrefix(field.comments);
    if (fieldDesc) {
      for (const commentLine of fieldDesc.split('\n')) {
        lines.push(`    /// ${commentLine}`);
      }
    }

    lines.push(fieldDeclarationLine(field));
  }

  for (const attribute of model.attributes) {
    const name = attribute.decl.ref?.name;
    if (!name || name.startsWith('@@@')) {
      continue;
    }

    const args = attribute.args.map((a) => a.$cstNode?.text ?? '').join(', ');
    lines.push(`    ${name}(${args})`);
  }

  lines.push('}');
  return lines;
}

/**
 * Renders the schema overview section with entity counts and a categorized entity list.
 */
function renderOverview(
  title: string,
  counts: SkillCounts,
  models: DataModel[],
  views: DataModel[],
): string[] {
  const lines: string[] = [];
  lines.push(`# ${title} — Schema Skill`);
  lines.push('');
  lines.push(
    `This skill provides the data schema context for ${title}. Consult it whenever you need to understand the data model, write type-safe code against it, or respect its constraints.`,
  );
  lines.push('');
  lines.push('## Schema Overview');
  lines.push('');
  lines.push(`This schema contains ${formatCountSummary(counts)}.`);
  lines.push('');

  const allEntities = [...models, ...views].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (allEntities.length > 0) {
    lines.push('Entities:');
    for (const m of allEntities) {
      const desc = stripCommentPrefix(m.comments);
      const kind = m.isView ? 'View' : 'Model';
      const descPart = desc ? ` — ${desc.split('\n')[0]}` : '';
      lines.push(`- **${m.name}** (${kind})${descPart}`);
    }

    lines.push('');
  }

  return lines;
}

/**
 * Renders an access policy matrix table (Model x Operation).
 */
function renderPolicyMatrix(models: DataModel[]): string[] {
  const modelsWithPolicies = models.filter((m) =>
    m.attributes.some((a) => {
      const name = a.decl.ref?.name;
      return name === '@@allow' || name === '@@deny';
    }),
  );

  if (modelsWithPolicies.length === 0) {
    return [];
  }

  const operations = ['create', 'read', 'update', 'delete', 'all'];

  const lines: string[] = [
    '## Access Policies',
    '',
    'ZenStack enforces these rules at the ORM level. Your code does not need to re-implement them, but you must be aware of them when reasoning about what operations will succeed or fail.',
    '',
  ];

  if (hasAuthRules(models)) {
    lines.push(
      '> Some rules reference `auth()` — the currently authenticated user. Operations that require `auth()` will fail for unauthenticated requests.',
    );
    lines.push('');
  }

  lines.push(
    '| Model | Operation | Rule | Effect |',
    '| ----- | --------- | ---- | ------ |',
  );

  for (const model of modelsWithPolicies.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    for (const attribute of model.attributes) {
      const name = attribute.decl.ref?.name;
      if (name !== '@@allow' && name !== '@@deny') {
        continue;
      }

      const effect = name === '@@allow' ? 'allow' : 'deny';
      const argTexts = attribute.args.map((a) => a.$cstNode?.text ?? '');
      const operation = argTexts[0]?.replaceAll(/['"]/gu, '') ?? 'all';
      const condition = argTexts[1] ?? 'true';

      const matchedOps =
        operation === 'all'
          ? operations.filter((o) => o !== 'all')
          : [operation];

      for (const op of matchedOps) {
        lines.push(`| ${model.name} | ${op} | ${condition} | ${effect} |`);
      }
    }
  }

  lines.push('');
  return lines;
}

/**
 * Renders a compact Mermaid ERD showing only entity names and relationship connectors.
 */
function renderRelationshipMap(relations: Relationship[]): string[] {
  if (relations.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const connectorLines: string[] = [];
  for (const rel of relations) {
    const key = relationDedupKey(rel);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    connectorLines.push(relationToMermaid(rel));
  }

  if (connectorLines.length === 0) {
    return [];
  }

  return [
    '## Relationship Map',
    '',
    '```mermaid',
    'erDiagram',
    ...connectorLines,
    '```',
    '',
  ];
}

/**
 * Renders a consolidated relationships quick-reference table.
 */
function renderRelationshipsTable(relations: Relationship[]): string[] {
  if (relations.length === 0) {
    return [];
  }

  const lines: string[] = [
    '## Relationships',
    '',
    '| From | Field | To | Cardinality |',
    '| ---- | ----- | -- | ----------- |',
  ];

  const labelMap: Record<RelationType, string> = {
    'Many\u2192Many': 'Many-to-Many',
    'Many\u2192One': 'Many-to-One',
    'Many\u2192One?': 'Many-to-One (optional)',
    'One\u2192Many': 'One-to-Many',
    'One\u2192One': 'One-to-One',
    'One\u2192One?': 'One-to-One (optional)',
  };

  for (const rel of relations) {
    lines.push(
      `| ${rel.from} | ${rel.field} | ${rel.to} | ${labelMap[rel.type]} |`,
    );
  }

  lines.push('');
  return lines;
}

/**
 * Lists the minimum required fields (non-optional, no-default, non-relation) per model.
 */
function renderRequiredFieldsPerModel(models: DataModel[]): string[] {
  const lines: string[] = [];
  for (const model of [...models].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const allFields = getAllFields(model, true);
    const required = allFields.filter((f) => {
      if (f.type.optional || f.type.array) {
        return false;
      }

      if (f.type.reference?.ref && isDataModel(f.type.reference.ref)) {
        return false;
      }

      if (
        f.attributes.some((a) => {
          const name = getAttributeName(a);
          return (
            name === '@default' || name === '@updatedAt' || name === '@computed'
          );
        })
      ) {
        return false;
      }

      return true;
    });

    if (required.length === 0) {
      continue;
    }

    const fieldList = required
      .map((f) => `\`${f.name}\` (${resolveTypeName(f.type)})`)
      .join(', ');
    lines.push(`- **${model.name}**: ${fieldList}`);
  }

  return lines;
}

/**
 * Renders a type definition declaration block with fields and doc comments.
 */
function renderTypeDeclaration(td: TypeDef): string[] {
  const lines: string[] = [];
  const desc = stripCommentPrefix(td.comments);
  if (desc) {
    for (const dLine of desc.split('\n')) {
      lines.push(`/// ${dLine}`);
    }
  }

  lines.push(`type ${td.name} {`);
  for (const field of td.fields) {
    const fieldDesc = stripCommentPrefix(field.comments);
    if (fieldDesc) {
      lines.push(`    /// ${fieldDesc}`);
    }

    lines.push(fieldDeclarationLine(field));
  }

  lines.push('}');
  return lines;
}

/**
 * Renders step-by-step guidance for writing queries, calling procedures, and generating test data.
 */
function renderWorkflow(
  models: DataModel[],
  procedures: Procedure[],
  relations: Relationship[],
  hasRelationships: boolean,
): string[] {
  const lines: string[] = [];
  lines.push('## How To Use This Schema');
  lines.push('');

  lines.push('### Writing queries or mutations');
  lines.push('');
  lines.push('1. Find the model in the Entity Reference below');
  lines.push('2. Check its fields for types, optionality, and defaults');
  lines.push(
    '3. Check access policies — will the operation be allowed for the current user?',
  );
  lines.push(
    '4. Check validation — will the input values pass schema-level validation?',
  );
  lines.push('5. For full field details, follow the entity documentation link');
  lines.push('');

  const includePatterns = renderIncludePatterns(relations);
  if (includePatterns.length > 0) {
    lines.push('**Common include patterns:**');
    lines.push('');
    for (const pattern of includePatterns) {
      lines.push(pattern);
    }

    lines.push('');
  }

  const requiredFieldsSection = renderRequiredFieldsPerModel(models);
  if (requiredFieldsSection.length > 0) {
    lines.push('### Creating records');
    lines.push('');
    lines.push('Minimum required fields per model:');
    lines.push('');
    for (const line of requiredFieldsSection) {
      lines.push(line);
    }

    lines.push('');
  }

  if (procedures.length > 0) {
    lines.push('### Calling procedures');
    lines.push('');
    lines.push(
      'This schema defines server-side procedures. Use them instead of writing raw queries when available:',
    );
    lines.push('');
    const sorted = [...procedures].sort((a, b) => a.name.localeCompare(b.name));
    for (const proc of sorted) {
      const kind = proc.mutation ? 'mutation' : 'query';
      const parameters = proc.params
        .map((p) => {
          let typeName = resolveTypeName(p.type);
          if (p.type.array) {
            typeName += '[]';
          }

          if (p.optional) {
            typeName += '?';
          }

          return `${p.name}: ${typeName}`;
        })
        .join(', ');
      let returnType = resolveTypeName(proc.returnType);
      if (returnType === 'Unknown') {
        returnType = 'Void';
      }

      if (proc.returnType.array) {
        returnType += '[]';
      }

      const desc = extractProcedureComments(proc, ' ');
      const descPart = desc ? ` — ${desc}` : '';
      lines.push(
        `- \`${proc.name}(${parameters}) → ${returnType}\` *(${kind})*${descPart} — [${proc.name} (Procedure)](./procedures/${proc.name}.md)`,
      );
    }

    lines.push('');
  }

  lines.push('### Generating test data');
  lines.push('');
  lines.push('When creating seed data or test fixtures:');
  lines.push('');
  lines.push(
    '- Respect `@unique` constraints — duplicate values will cause insert failures',
  );
  lines.push('- Satisfy validation rules (see Constraints above)');
  lines.push('- Provide all required foreign keys for relations');
  lines.push(
    '- Fields with `@default(...)` can be omitted — the database generates them',
  );
  lines.push('- Fields with `@computed` cannot be set — they are derived');
  lines.push('');

  const creationOrder = topologicalSort(models);
  if (creationOrder.length > 1) {
    lines.push(
      `**Creation order** (respects FK dependencies): ${creationOrder.map((n) => `\`${n}\``).join(' → ')}`,
    );
    lines.push('');
  }

  if (hasRelationships) {
    lines.push('### Understanding relationships');
    lines.push('');
    lines.push(
      'See the [relationships page](./relationships.md) for a full ER diagram and cross-reference table.',
    );
    lines.push('');
  }

  return lines;
}

/**
 * Topologically sorts models by FK dependencies so dependent models come after their parents.
 */
function topologicalSort(models: DataModel[]): string[] {
  const modelNames = new Set(models.map((m) => m.name));
  const deps = new Map<string, Set<string>>();
  for (const m of models) {
    deps.set(m.name, new Set());
  }

  for (const model of models) {
    for (const field of getAllFields(model, true)) {
      if (
        field.type.reference?.ref &&
        isDataModel(field.type.reference.ref) &&
        !field.type.array &&
        !field.type.optional
      ) {
        const target = field.type.reference.ref.name;
        if (modelNames.has(target) && target !== model.name) {
          deps.get(model.name)!.add(target);
        }
      }
    }
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) {
      return;
    }

    if (visiting.has(name)) {
      return;
    }

    visiting.add(name);
    for (const dep of deps.get(name) ?? []) {
      visit(dep);
    }

    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const name of [...modelNames].sort()) {
    visit(name);
  }

  return sorted;
}
