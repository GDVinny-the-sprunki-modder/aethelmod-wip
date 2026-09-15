// Name: WebGL Sprite Warp
// ID: webglSpriteWarp
// Description: Warp sprites using TurboWarp's WebGL renderer.
// Based on the same WebGL shader technique used by SharkPool's warp.
// License: MIT

(function (Scratch) {
    "use strict";

    if (!Scratch.extensions.unsandboxed) {
        throw new Error("WebGL Sprite Warp must run unsandboxed!");
    }

    const vm = Scratch.vm;
    const runtime = vm.runtime;
    const renderer = vm.renderer;
    const twgl = renderer.exports.twgl;
    const Cast = Scratch.Cast;

    const drawableKey = Symbol("webglSpriteWarp");

    // SharkPool's default warp values.
    // This represents:
    // x1=-100 y1=100
    // x2= 100 y2=100
    // x3=-100 y3=-100
    // x4= 100 y4=-100
    const DEFAULT_WARP = [
        0.5, -0.5,
        -0.5, -0.5,
        -0.5, 0.5,
        0.5, 0.5
    ];

    function initDrawable(drawable) {
        if (!drawable[drawableKey]) {
            drawable[drawableKey] = {
                warp: [...DEFAULT_WARP]
            };
        }
    }

    /*
     * ------------------------------------------------------------
     * WEBGL SHADER PATCH
     * ------------------------------------------------------------
     *
     * TurboWarp normally calculates each vertex's position itself.
     * We replace that position with a bilinear interpolation between
     * four user-controlled points.
     */

    let patchShaders = false;

    const originalCreateProgramInfo = twgl.createProgramInfo;

    twgl.createProgramInfo = function (...args) {
        if (
            patchShaders &&
            args[1] &&
            args[1][0] &&
            args[1][1]
        ) {
            // Vertex shader
            args[1][0] = args[1][0]
                .replaceAll(
                    "vec4(a_position",
                    "vec4(positionSP"
                )

                // TurboWarp normally assigns the texture coordinate
                // elsewhere. We need it before calculating the warp.
                .replace(
                    "v_texCoord = a_texCoord;",
                    ""
                )

                .replace(
                    "#if !(defined(DRAW_MODE_line) || defined(DRAW_MODE_background))",
                    "#if 1"
                )

                .replace(
                    "void main() {",
`uniform vec2 u_warpSP[4];

void main() {
    vec2 positionSP = a_position;

#ifndef DRAW_MODE_background
    v_texCoord = a_texCoord;
#endif

    // Texture coordinates.
    float u = v_texCoord.x;
    float v = v_texCoord.y;

    /*
     * Bilinear interpolation.

     * u_warpSP[0] = top-left
     * u_warpSP[1] = top-right
     * u_warpSP[2] = bottom-right
     * u_warpSP[3] = bottom-left
     */

    vec2 warpedPos =
        (1.0 - u) * (1.0 - v) * u_warpSP[0] +
        u         * (1.0 - v) * u_warpSP[1] +
        u         * v         * u_warpSP[2] +
        (1.0 - u) * v         * u_warpSP[3];

    positionSP = warpedPos;

#ifdef DRAW_MODE_background
    gl_Position = vec4(positionSP * 2.0, 0.0, 1.0);
#else
    gl_Position =
        u_projectionMatrix *
        u_modelMatrix *
        vec4(positionSP, 0.0, 1.0);
#endif
`
                );

            // Fragment shader doesn't need modification for the warp.
            //
            // The uniform is nevertheless declared here so that
            // WebGL can locate it in the shader program.
            args[1][1] = args[1][1].replace(
                "uniform sampler2D u_skin;",
`uniform sampler2D u_skin;
uniform vec2 u_warpSP[4];`
            );
        }

        return originalCreateProgramInfo.apply(this, args);
    };

    /*
     * Force TurboWarp to rebuild its shaders after our patch.
     */
    const shaderCache = renderer._shaderManager._shaderCache;

    for (const cache of Object.values(shaderCache)) {
        for (const programInfo of cache) {
            if (programInfo) {
                renderer.gl.deleteProgram(programInfo.program);
            }
        }

        cache.length = 0;
    }

    const originalBuildShader =
        renderer._shaderManager._buildShader;

    renderer._shaderManager._buildShader = function (...args) {
        try {
            patchShaders = true;
            return originalBuildShader.apply(this, args);
        } finally {
            patchShaders = false;
        }
    };

    /*
     * ------------------------------------------------------------
     * UNIFORM SUPPORT
     * ------------------------------------------------------------
     *
     * Instead of replacing TurboWarp's whole drawing system,
     * add the warp uniform to Drawable.getUniforms().
     */

    const originalGetUniforms =
        renderer.exports.Drawable.prototype.getUniforms;

    renderer.exports.Drawable.prototype.getUniforms = function () {
        const uniforms = originalGetUniforms.call(this);

        initDrawable(this);

        uniforms.u_warpSP =
            this[drawableKey].warp;

        return uniforms;
    };

    /*
     * ------------------------------------------------------------
     * RESET SUPPORT
     * ------------------------------------------------------------
     *
     * Scratch's "clear graphic effects" should also reset our warp.
     */

    const originalClearEffects =
        vm.exports.RenderedTarget.prototype.clearEffects;

    vm.exports.RenderedTarget.prototype.clearEffects =
        function () {
            const drawable =
                renderer._allDrawables[this.drawableID];

            if (drawable) {
                drawable[drawableKey] = {
                    warp: [...DEFAULT_WARP]
                };
            }

            originalClearEffects.call(this);
        };

    /*
     * ------------------------------------------------------------
     * CLONE SUPPORT
     * ------------------------------------------------------------
     *
     * New clones inherit the original sprite's warp.
     */

    const originalInitDrawable =
        vm.exports.RenderedTarget.prototype.initDrawable;

    vm.exports.RenderedTarget.prototype.initDrawable =
        function (layerGroup) {
            originalInitDrawable.call(this, layerGroup);

            if (this.isOriginal) return;

            const parentSprite = this.sprite.clones[0];

            if (!parentSprite) return;

            const parentDrawable =
                renderer._allDrawables[parentSprite.drawableID];

            if (!parentDrawable) return;

            initDrawable(parentDrawable);

            const drawable =
                renderer._allDrawables[this.drawableID];

            if (!drawable) return;

            drawable[drawableKey] = {
                warp: [
                    ...parentDrawable[drawableKey].warp
                ]
            };
        };

    /*
     * ------------------------------------------------------------
     * BOUNDS SUPPORT
     * ------------------------------------------------------------
     *
     * This makes TurboWarp's reported sprite bounds account for
     * the warped shape.
     */

    const radians = Math.PI / 180;

    function rotatePoint(x, y, cx, cy, angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const dx = x - cx;
        const dy = y - cy;

        return {
            x: cx + dx * cos - dy * sin,
            y: cy + dx * sin + dy * cos
        };
    }

    function warpBounds(drawable, bounds) {
        if (!drawable[drawableKey]) {
            return bounds;
        }

        const warp = drawable[drawableKey].warp;

        if (
            warp.join(",") ===
            DEFAULT_WARP.join(",")
        ) {
            return bounds;
        }

        /*
         * Convert the shader coordinates back into Scratch
         * coordinate space.
         */

        const values = warp.map((value, index) => {
            if (index > 0 && index < 5) {
                return value * -1;
            }

            return value;
        });

        const angle =
            (drawable._direction - 90) * radians;

        const [x, y] = drawable._position;

        const width =
            drawable.skin.size[0] *
            (drawable.scale[0] / 200);

        const height =
            drawable.skin.size[1] *
            (drawable.scale[1] / 200);

        const points = [
            {
                x: (values[0] * 2) * -width + x,
                y: (values[1] * -2) * height - y
            },

            {
                x: (values[2] * 2) * width + x,
                y: (values[3] * -2) * height - y
            },

            {
                x: (values[4] * 2) * width + x,
                y: (values[5] * -2) * -height - y
            },

            {
                x: (values[6] * 2) * -width + x,
                y: (values[7] * -2) * -height - y
            }
        ];

        const rotatedPoints =
            points.map(point =>
                rotatePoint(
                    point.x,
                    point.y,
                    x,
                    -y,
                    angle
                )
            );

        const xs =
            rotatedPoints.map(point => point.x);

        const ys =
            rotatedPoints.map(point => point.y);

        bounds.left = Math.min(...xs);
        bounds.top = -Math.min(...ys);
        bounds.right = Math.max(...xs);
        bounds.bottom = -Math.max(...ys);

        return bounds;
    }

    const originalGetBounds =
        renderer.exports.Drawable.prototype.getBounds;

    renderer.exports.Drawable.prototype.getBounds =
        function () {
            return warpBounds(
                this,
                originalGetBounds.call(this)
            );
        };

    const originalGetAABB =
        renderer.exports.Drawable.prototype.getAABB;

    renderer.exports.Drawable.prototype.getAABB =
        function () {
            return warpBounds(
                this,
                originalGetAABB.call(this)
            );
        };

    /*
     * ------------------------------------------------------------
     * EXTENSION
     * ------------------------------------------------------------
     */

    class WebGLSpriteWarp {

        getInfo() {
            return {
                id: "webglSpriteWarp",
                name: "WebGL Sprite Warp",

                color1: "#9966FF",
                color2: "#855CD6",
                color3: "#774DCB",

                blocks: [

                    {
                        opcode: "warpSprite",
                        blockType: Scratch.BlockType.COMMAND,

                        text:
                            "warp [TARGET] to x1: [X1] y1: [Y1] x2: [X2] y2: [Y2] x3: [X3] y3: [Y3] x4: [X4] y4: [Y4]",

                        arguments: {

                            TARGET: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "TARGETS"
                            },

                            X1: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: -100
                            },

                            Y1: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            },

                            X2: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            },

                            Y2: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            },

                            X3: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: -100
                            },

                            Y3: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: -100
                            },

                            X4: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            },

                            Y4: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: -100
                            }
                        }
                    },

                    {
                        opcode: "resetWarp",
                        blockType: Scratch.BlockType.COMMAND,

                        text:
                            "reset warp of [TARGET]",

                        arguments: {
                            TARGET: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "TARGETS"
                            }
                        }
                    },

                    {
                        opcode: "setWarpPoint",
                        blockType: Scratch.BlockType.COMMAND,

                        text:
                            "set warp point [POINT] of [TARGET] x [X] y [Y]",

                        arguments: {

                            POINT: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "POINTS"
                            },

                            TARGET: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "TARGETS"
                            },

                            X: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 0
                            },

                            Y: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 0
                            }
                        }
                    },

                    {
                        opcode: "warpPoint",
                        blockType: Scratch.BlockType.REPORTER,

                        text:
                            "warp [POINT] [AXIS] of [TARGET]",

                        arguments: {

                            POINT: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "POINTS"
                            },

                            AXIS: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "AXES"
                            },

                            TARGET: {
                                type: Scratch.ArgumentType.STRING,
                                menu: "TARGETS"
                            }
                        }
                    }
                ],

                menus: {

                    TARGETS: {
                        acceptReporters: true,
                        items: "getTargets"
                    },

                    POINTS: [
                        "top-left",
                        "top-right",
                        "bottom-right",
                        "bottom-left"
                    ],

                    AXES: [
                        "x",
                        "y"
                    ]
                }
            };
        }

        getTargets() {
            const targets = [
                {
                    text: "myself",
                    value: "_myself_"
                },

                {
                    text: "Stage",
                    value: "_stage_"
                }
            ];

            for (let i = 1; i < runtime.targets.length; i++) {
                const target = runtime.targets[i];

                if (target.isOriginal) {
                    targets.push({
                        text: target.getName(),
                        value: target.getName()
                    });
                }
            }

            return targets;
        }

        getTarget(name, util) {
            if (name === "_myself_") {
                return util.target;
            }

            if (name === "_stage_") {
                return runtime.getTargetForStage();
            }

            return runtime.getSpriteTargetByName(name);
        }

        /*
         * Convert Scratch's four corner coordinates into the
         * normalized coordinates used by the WebGL shader.
         *
         * This intentionally follows SharkPool's coordinate
         * conversion:
         *
         * x / -200
         * y / -200
         */

        makeWarp(x1, y1, x2, y2, x3, y3, x4, y4) {
            return [
                Cast.toNumber(x1) / -200,
                Cast.toNumber(y1) / -200,

                Cast.toNumber(x2) / -200,
                Cast.toNumber(y2) / -200,

                Cast.toNumber(x4) / -200,
                Cast.toNumber(y4) / -200,

                Cast.toNumber(x3) / -200,
                Cast.toNumber(y3) / -200
            ];
        }

        warpSprite(args, util) {
            const target =
                this.getTarget(args.TARGET, util);

            if (!target || target.isStage) return;

            const drawable =
                renderer._allDrawables[target.drawableID];

            if (!drawable) return;

            initDrawable(drawable);

            const newWarp = this.makeWarp(
                args.X1,
                args.Y1,

                args.X2,
                args.Y2,

                args.X3,
                args.Y3,

                args.X4,
                args.Y4
            );

            drawable[drawableKey].warp = newWarp;

            renderer.dirty = true;
        }

        resetWarp(args, util) {
            const target =
                this.getTarget(args.TARGET, util);

            if (!target || target.isStage) return;

            const drawable =
                renderer._allDrawables[target.drawableID];

            if (!drawable) return;

            initDrawable(drawable);

            drawable[drawableKey].warp =
                [...DEFAULT_WARP];

            renderer.dirty = true;
        }

        setWarpPoint(args, util) {
            const target =
                this.getTarget(args.TARGET, util);

            if (!target || target.isStage) return;

            const drawable =
                renderer._allDrawables[target.drawableID];

            if (!drawable) return;

            initDrawable(drawable);

            const warp =
                drawable[drawableKey].warp;

            const point =
                Cast.toString(args.POINT);

            const x =
                Cast.toNumber(args.X) / -200;

            const y =
                Cast.toNumber(args.Y) / -200;

            /*
             * Internal order:
             *
             * 0 = top-left
             * 1 = top-right
             * 2 = bottom-right
             * 3 = bottom-left
             */

            let index;

            switch (point) {
                case "top-left":
                    index = 0;
                    break;

                case "top-right":
                    index = 1;
                    break;

                case "bottom-right":
                    index = 2;
                    break;

                case "bottom-left":
                    index = 3;
                    break;

                default:
                    return;
            }

            warp[index * 2] = x;
            warp[index * 2 + 1] = y;

            renderer.dirty = true;
        }

        warpPoint(args, util) {
            const target =
                this.getTarget(args.TARGET, util);

            if (!target || target.isStage) {
                return 0;
            }

            const drawable =
                renderer._allDrawables[target.drawableID];

            if (!drawable) return 0;

            initDrawable(drawable);

            const point =
                Cast.toString(args.POINT);

            const axis =
                Cast.toString(args.AXIS);

            let index;

            switch (point) {
                case "top-left":
                    index = 0;
                    break;

                case "top-right":
                    index = 1;
                    break;

                case "bottom-right":
                    index = 2;
                    break;

                case "bottom-left":
                    index = 3;
                    break;

                default:
                    return 0;
            }

            const value =
                drawable[drawableKey].warp[
                    index * 2 +
                    (axis === "y" ? 1 : 0)
                ];

            // Convert WebGL normalized coordinate back
            // into the block's coordinate system.
            return value * -200;
        }
    }

    Scratch.extensions.register(
        new WebGLSpriteWarp()
    );

})(Scratch);
