import { generateFromSchema, readDoc as readDocument } from '../utils';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TWO_MODEL_SCHEMA = `
  model User {
      id    String @id @default(cuid())
      name  String
      posts Post[]
  }
  model Post {
      id       String @id @default(cuid())
      title    String
      author   User   @relation(fields: [authorId], references: [id])
      authorId String
  }
`;

describe('documentation plugin: per-page SVG diagrams', () => {
  it('model page references companion SVG file when diagramFormat is svg', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'svg',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).not.toContain('```mermaid');
    expect(userDocument).toContain('![User diagram](./User-diagram.svg)');

    const svgPath = path.join(tmpDir, 'models', 'User-diagram.svg');
    expect(fs.existsSync(svgPath)).toBe(true);
    expect(fs.readFileSync(svgPath, 'utf8')).toContain('<svg');
  });

  it('uses descriptive alt text based on entity name', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'svg',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain('![User diagram]');
    expect(userDocument).not.toContain('![diagram]');

    const postDocument = readDocument(tmpDir, 'models', 'Post.md');
    expect(postDocument).toContain('![Post diagram]');
  });

  it('wraps diagram output in responsive container div', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'svg',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain(
      '<div style="max-width:100%;overflow-x:auto">',
    );
    expect(userDocument).toContain('</div>');
  });

  it('model page has SVG image and collapsible mermaid when diagramFormat is both', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'both',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain('![User diagram](./User-diagram.svg)');
    expect(userDocument).toContain('```mermaid');
    expect(userDocument).toContain('<details>');
    expect(userDocument).toContain('Mermaid source');

    expect(fs.existsSync(path.join(tmpDir, 'models', 'User-diagram.svg'))).toBe(
      true,
    );
  });

  it('default behavior preserves inline mermaid with no SVG files', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA);

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain('```mermaid');
    expect(userDocument).not.toContain('![User diagram]');
    expect(fs.existsSync(path.join(tmpDir, 'models', 'User-diagram.svg'))).toBe(
      false,
    );
  });

  it('enum page gets companion SVG when diagramFormat is svg', async () => {
    const tmpDir = await generateFromSchema(
      `
            model User {
                id   String @id @default(cuid())
                role Role
            }
            enum Role { ADMIN USER }
            `,
      { diagramFormat: 'svg' },
    );

    const enumDocument = readDocument(tmpDir, 'enums', 'Role.md');
    expect(enumDocument).not.toContain('```mermaid');
    expect(enumDocument).toContain('![Role diagram](./Role-diagram.svg)');
    expect(fs.existsSync(path.join(tmpDir, 'enums', 'Role-diagram.svg'))).toBe(
      true,
    );
  });

  it('procedure page gets companion SVG when diagramFormat is svg', async () => {
    const tmpDir = await generateFromSchema(
      `
            model User {
                id   String @id @default(cuid())
                name String
            }
            procedure getUser(id: String): User
            `,
      { diagramFormat: 'svg' },
    );

    const procDocument = readDocument(tmpDir, 'procedures', 'getUser.md');
    expect(procDocument).not.toContain('```mermaid');
    expect(procDocument).toContain('![getUser diagram](./getUser-diagram.svg)');
    expect(
      fs.existsSync(path.join(tmpDir, 'procedures', 'getUser-diagram.svg')),
    ).toBe(true);
  });

  it('relationships page gets companion SVG when diagramFormat is svg', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'svg',
    });

    const relDocument = readDocument(tmpDir, 'relationships.md');
    expect(relDocument).not.toContain('```mermaid');
    expect(relDocument).toContain(
      '![relationships diagram](./relationships-diagram.svg)',
    );
    expect(fs.existsSync(path.join(tmpDir, 'relationships-diagram.svg'))).toBe(
      true,
    );
  });

  it('erdTheme applies to companion SVG files', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'svg',
      erdTheme: 'dracula',
    });

    const svgPath = path.join(tmpDir, 'models', 'User-diagram.svg');
    expect(fs.existsSync(svgPath)).toBe(true);
    expect(fs.readFileSync(svgPath, 'utf8')).toContain('<svg');
  });

  it('view page gets companion SVG when diagramFormat is svg', async () => {
    const tmpDir = await generateFromSchema(
      `
            model User {
                id   String @id @default(cuid())
                name String
            }
            view UserProfile {
                name String
            }
            `,
      { diagramFormat: 'svg' },
    );

    const viewDocument = readDocument(tmpDir, 'views', 'UserProfile.md');
    expect(viewDocument).not.toContain('```mermaid');
    expect(viewDocument).toContain(
      '![UserProfile diagram](./UserProfile-diagram.svg)',
    );
    expect(
      fs.existsSync(path.join(tmpDir, 'views', 'UserProfile-diagram.svg')),
    ).toBe(true);
  });
});

describe('documentation plugin: inline SVG embedding', () => {
  it('embeds SVG content directly in markdown when diagramEmbed is inline', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramEmbed: 'inline',
      diagramFormat: 'svg',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).not.toContain('```mermaid');
    expect(userDocument).toContain('<svg');
    expect(userDocument).toContain('</svg>');
    expect(userDocument).not.toContain('![User diagram]');

    expect(fs.existsSync(path.join(tmpDir, 'models', 'User-diagram.svg'))).toBe(
      false,
    );
  });

  it('wraps inline SVG in responsive container', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramEmbed: 'inline',
      diagramFormat: 'svg',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain(
      '<div style="max-width:100%;overflow-x:auto">',
    );
  });

  it('inline mode with both format includes SVG and collapsible mermaid source', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramEmbed: 'inline',
      diagramFormat: 'both',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain('<svg');
    expect(userDocument).toContain('```mermaid');
    expect(userDocument).toContain('<details>');
    expect(userDocument).toContain('Mermaid source');

    expect(fs.existsSync(path.join(tmpDir, 'models', 'User-diagram.svg'))).toBe(
      false,
    );
  });

  it('inline mode does not produce companion SVG files', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramEmbed: 'inline',
      diagramFormat: 'svg',
    });

    const modelsDir = path.join(tmpDir, 'models');
    const files = fs.readdirSync(modelsDir);
    const svgFiles = files.filter((f) => f.endsWith('.svg'));
    expect(svgFiles).toHaveLength(0);
  });

  it('diagramEmbed is ignored when diagramFormat is mermaid', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramEmbed: 'inline',
      diagramFormat: 'mermaid',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain('```mermaid');
    expect(userDocument).not.toContain('<svg');
  });

  it('defaults to file mode when diagramEmbed is not specified', async () => {
    const tmpDir = await generateFromSchema(TWO_MODEL_SCHEMA, {
      diagramFormat: 'svg',
    });

    const userDocument = readDocument(tmpDir, 'models', 'User.md');
    expect(userDocument).toContain('![User diagram](./User-diagram.svg)');
    expect(fs.existsSync(path.join(tmpDir, 'models', 'User-diagram.svg'))).toBe(
      true,
    );
  });
});
