import tseslint from "typescript-eslint";
export default tseslint.config({
  files:["**/*.ts"],
  ignores:["**/dist/**","**/generated/**"],
  languageOptions:{parser:tseslint.parser,parserOptions:{projectService:true,tsconfigRootDir:import.meta.dirname}},
  plugins:{"@typescript-eslint":tseslint.plugin},
  rules:{"@typescript-eslint/no-floating-promises":"error","@typescript-eslint/no-misused-promises":"error","@typescript-eslint/await-thenable":"error"}
});
