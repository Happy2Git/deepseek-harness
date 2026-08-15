// @vitest-environment jsdom
/**
 * File-glyph kind mapping: the extension → glyph-family function the file
 * rows render through. Pure-name coverage — the mapping is the only decision
 * worth pinning (the glyphs themselves are design-system icons).
 */
import { describe, expect, it } from 'vitest'
import { fileIconKind } from '@deepseek-ai/dsh-client-ui-context-files/src/client/file-icon.tsx'

describe('fileIconKind', () => {
  it('maps source and stylesheet extensions to code', () => {
    expect(fileIconKind('app.ts')).toBe('code')
    expect(fileIconKind('Component.tsx')).toBe('code')
    expect(fileIconKind('main.py')).toBe('code')
    expect(fileIconKind('styles.css')).toBe('code')
  })

  it('maps data and configuration extensions to data', () => {
    expect(fileIconKind('package.json')).toBe('data')
    expect(fileIconKind('config.yaml')).toBe('data')
    expect(fileIconKind('data.csv')).toBe('data')
  })

  it('maps compressed archives to archive', () => {
    expect(fileIconKind('bundle.zip')).toBe('archive')
    expect(fileIconKind('release.tar.gz')).toBe('archive')
  })

  it('falls back to doc for documents and unknown names', () => {
    expect(fileIconKind('README.md')).toBe('doc')
    expect(fileIconKind('notes.txt')).toBe('doc')
    expect(fileIconKind('Makefile')).toBe('doc')
    expect(fileIconKind('LICENSE')).toBe('doc')
  })

  it('handles dotfiles and names without a real extension', () => {
    expect(fileIconKind('.gitignore')).toBe('data')
    expect(fileIconKind('.env')).toBe('data')
    expect(fileIconKind('file.')).toBe('doc')
    expect(fileIconKind('noext')).toBe('doc')
  })
})
