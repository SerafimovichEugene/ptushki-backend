module.exports = {
  semi: true,
  trailingComma: 'all',
  singleQuote: true,
  bracketSpacing: true,
  endOfLine: 'lf',
  printWidth: 120,
  tabWidth: 2,
  overrides: [
    {
      files: ['*.json', '.eslintrc'],
      options: {
        parser: 'json',
        bracketSpacing: false,
        singleQuote: false,
      },
    },
    {
      files: ['*.ts'],
      options: {
        parser: 'typescript',
      },
    },
    {
      files: '*.md',
      options: {
        parser: 'markdown',
      },
    },
    {
      files: '*.ya?ml',
      options: {
        parser: 'yaml',
      },
    },
  ],
};
