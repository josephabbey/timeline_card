import css from "rollup-plugin-import-css";
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";

export default [{
    input: "src/card.ts",
    plugins: [nodeResolve({}), commonjs(), css(), typescript()],
    output: {
        format: "es",
        file: "./dist/timeline_card.js",
        sourcemap: false
    }
}];
