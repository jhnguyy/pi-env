cp -R "$PI_ENV_SOURCE" source
chmod -R u+w source
install -m 0755 "$PI_ENV_SETUP_SCRIPT" source/setup.sh
patchShebangs source
cd source

# The source has no node_modules. Dependency-backed workflows run in the repository portfolio.
bash setup/__tests__/setup-options.test.sh
bash setup/__tests__/node-policy.test.sh
bash setup/__tests__/verify-install.test.sh
node -e 'JSON.parse(require("fs").readFileSync("package.json", "utf8")); JSON.parse(require("fs").readFileSync("flake.lock", "utf8"));'
touch "$out"
