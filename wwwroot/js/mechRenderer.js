var mechRenderer = {
    canvas: null,
    engine: null,
    scene: null,
    camera: null,
    vehicle: null,
    inputMap: {},
    dotNetRef: null,
    fuel: 100,
    scrap: 0,
    speedRatio: 0.5,
    isDriving: true,
    lastSpawnTime: 0,

    setSpeedRatio: function (val) {
        // Map 1-100 to 0.25 - 1.0
        // User wants 1 = 25% speed, 100 = 100% speed.
        // val is 1-100.
        var pct = val / 100;
        // Simple linear for now: 100 is max, 0 is stop.
        // But user asked for 1 = 25%.
        // Let's do: 0.25 + (0.75 * (val / 100))
        this.speedRatio = 0.25 + (0.75 * (val / 100));
        if (this.speedRatio > 1.0) this.speedRatio = 1.0;
    },

    dispose: function () {
        if (this.engine) {
            this.engine.stopRenderLoop();
            this.engine.dispose();
            this.engine = null;
        }
        if (this.scene) {
            this.scene.dispose();
            this.scene = null;
        }
        this.vehicle = null;
        this.chassis = null;
    },

    setEnemySpeedRatio: function (val) {
        // Linear 1-100%
        this.enemySpeedRatio = val / 100.0;
    },

    initGarage: function (canvasId, dotNetRef) {
        this.dotNetRef = dotNetRef;
        this.canvas = document.getElementById(canvasId);
        this.engine = new BABYLON.Engine(this.canvas, true);
        this.scene = this.createGarageScene();

        window.addEventListener("resize", () => {
            if (this.engine) this.engine.resize();
        });

        this.engine.runRenderLoop(() => {
            if (this.scene) this.scene.render();
        });

        // Force browser to allow drop (fixes the "no-entry" 🚫 icon)
        var viewport = this.canvas.parentElement;
        viewport.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        });
    },

    createGarageScene: function () {
        var scene = new BABYLON.Scene(this.engine);
        scene.clearColor = new BABYLON.Color3(0.1, 0.1, 0.15); // Dark garage

        this.camera = new BABYLON.ArcRotateCamera("GarageCam", -Math.PI / 2, Math.PI / 3, 10, BABYLON.Vector3.Zero(), scene);
        this.camera.attachControl(this.canvas, true);
        this.camera.wheelPrecision = 50;

        var hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
        hemi.intensity = 0.8;

        // Showroom floor
        var ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 40, height: 40 }, scene);
        var gridMat = new BABYLON.StandardMaterial("gridMat", scene);
        gridMat.wireframe = true;
        gridMat.diffuseColor = new BABYLON.Color3(0.3, 0.3, 0.3);
        ground.material = gridMat;
        ground.position.y = -1.0;

        return scene;
    },

    // --- UNIVERSAL ASSEMBLY ENGINE ---
    assemblyRoot: null,
    assemblyData: null,

    // Internal recursive builder
    _buildAssembly: function (data, scene) {
        // Create Root Node
        var root = new BABYLON.TransformNode("AssemblyRoot", scene);
        var anchorMap = {};

        // PASS 0: Enrichment (Fill missing properties from Manifest)
        data.Parts.forEach(p => {
            var tid = p.TypeId || p.typeId;
            if (tid && this.manifest) {
                var def = this.manifest.find(m => m.Id === tid || m.id === tid);
                if (def) {
                    // Use ||= and only if property is missing to avoid overwriting instance data
                    if (!p.Shape && !p.shape) p.Shape = def.Shape || def.shape;
                    if (!p.ColorHex && !p.colorHex) p.ColorHex = def.ColorHex || def.colorHex;
                    if (!p.Scale && !p.scale) p.Scale = def.Scale || def.scale;
                    if (!p.Name && !p.name) p.Name = def.Name || def.name;
                    if (!p.Category && !p.category) p.Category = def.Category || def.category;
                    if (p.IsCore === undefined && p.isCore === undefined) p.IsCore = def.IsCore || def.isCore;
                }
            }
        });

        // Pass 1: Create Anchors & Visuals
        data.Parts.forEach(p => {

            var anchor = new BABYLON.TransformNode(p.Id + "_anchor", scene);
            anchorMap[p.Id] = anchor;

            // 2. Build Mesh (Fully Enriched)
            var mesh = this.buildPartAssemblyMesh(p, scene);
            if (mesh) {
                mesh.parent = anchor;

                var scale = p.Scale || p.scale;
                if (scale) {
                    mesh.scaling = new BABYLON.Vector3(scale[0], scale[1], scale[2]);
                }
            }
        });

        // Pass 2: Hierarchy
        data.Parts.forEach(p => {
            var anchor = anchorMap[p.Id];
            if (p.ParentId && anchorMap[p.ParentId]) {
                anchor.parent = anchorMap[p.ParentId];
            } else {
                anchor.parent = root;
            }

            if (p.Position || p.position) {
                var pos = p.Position || p.position;
                anchor.position = new BABYLON.Vector3(pos[0], pos[1], pos[2]);
            }
            if (p.Rotation || p.rotation) {
                var rot = p.Rotation || p.rotation;
                anchor.rotation.x = rot[0] * (Math.PI / 180);
                anchor.rotation.y = rot[1] * (Math.PI / 180);
                anchor.rotation.z = rot[2] * (Math.PI / 180);
            }
        });

        return root;
    },

    // --- BUILDER STATE ---
    manifest: [],
    activeSnapPoints: [], // Visual meshes

    setManifest: function (json) {
        if (typeof json === 'string') this.manifest = JSON.parse(json);
        else this.manifest = json;
    },

    showSnapPoints: function (partTypeId) {
        this.hideSnapPoints();
        if (!this.manifest || !this.assemblyData) return;

        var partDef = this.manifest.find(m => m.Id === partTypeId || m.id === partTypeId);
        if (!partDef) return;

        // Use Manifest Category for Snapping Tag
        var pCategory = partDef.Category || partDef.category || "Unknown";
        console.log(`ASSEMBLY: Showing slots for Category: ${pCategory}`);

        // RECURSIVE CONNECTOR SEARCH: Find connectors on EVERY part currently on the vehicle
        this.assemblyData.Parts.forEach(p => {
            var tid = p.TypeId || p.typeId;
            var def = this.manifest.find(m => m.Id === tid || m.id === tid);
            if (!def || (!def.Connectors && !def.connectors)) return;

            // Find visual anchor for this part
            var anchorName = (p.Id || p.id) + "_anchor";
            var parentAnchor = this.scene.getTransformNodeByName(anchorName);
            if (!parentAnchor) parentAnchor = this.assemblyRoot;

            var connectors = def.Connectors || def.connectors;
            connectors.forEach(c => {
                var isCompatible = false;
                var cId = c.Id || c.id;
                var cPos = c.Position || c.position;
                var cTypes = c.CompatibleTypes || c.compatibleTypes;

                // TAG MATCHING: Part Category must be in Connector's Compatible list
                if (cTypes.includes(pCategory)) isCompatible = true;

                // Legacy support for mixed case
                if (cTypes.includes(pCategory.toLowerCase())) isCompatible = true;

                if (isCompatible) {
                    var marker = BABYLON.MeshBuilder.CreateSphere("snap_" + cId, { diameter: 0.5 }, this.scene);
                    marker.position = new BABYLON.Vector3(cPos[0], cPos[1], cPos[2]);
                    marker.parent = parentAnchor;

                    var mat = new BABYLON.StandardMaterial("snapMat", this.scene);
                    mat.diffuseColor = new BABYLON.Color3(0, 1, 0);
                    mat.alpha = 0.5;
                    marker.material = mat;

                    marker.metadata = {
                        connectorId: cId,
                        parentPartId: p.Id || p.id,
                        parentTypeId: tid
                    };
                    this.activeSnapPoints.push(marker);
                }
            });
        });
    },

    hideSnapPoints: function () {
        this.activeSnapPoints.forEach(m => m.dispose());
        this.activeSnapPoints = [];
    },

    loadAssembly: function (jsonStr) {
        if (!this.scene) return;
        if (this.assemblyRoot) {
            this.assemblyRoot.dispose();
            this.assemblyRoot = null;
        }

        var data;
        try {
            data = (typeof jsonStr === 'string') ? JSON.parse(jsonStr) : jsonStr;
        } catch (e) { console.error("Invalid JSON", e); return; }

        console.log(`Assembly Built: ${data.name || 'Unknown'}`);

        this.assemblyData = data;
        this.assemblyRoot = this._buildAssembly(data, this.scene);

        // LOG AFTER BUILD so enrichment shows up
        console.table(data.Parts.map(p => ({
            Id: p.Id || p.id,
            Category: p.Category || p.category || "Unknown",
            Shape: p.Shape || p.shape,
            Parent: p.ParentId || p.parentId
        })));
    },

    clearAssembly: function () {
        if (!this.assemblyData) return;

        // Keep ONLY parts marked as IsCore
        var cores = this.assemblyData.Parts.filter(p => p.IsCore || p.isCore);
        if (cores.length > 0) {
            this.assemblyData.Parts = cores;
            this.loadAssembly(this.assemblyData);
        }
        console.log("Assembly cleared to Core.");
    },

    getAssemblyData: function () {
        return JSON.stringify(this.assemblyData);
    },

    downloadAssembly: function (filename) {
        if (!this.assemblyData) return;
        var json = JSON.stringify(this.assemblyData, null, 2);
        var blob = new Blob([json], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename || "assembly_blueprint.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    importAssembly: function (onComplete) {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = (e) => {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = (re) => {
                var json = re.target.result;
                this.loadAssembly(json);
                if (onComplete) onComplete(json);
            };
            reader.readAsText(file);
        };
        input.click();
    },

    handlePartAssembly: function (partTypeId, screenX, screenY) {
        if (!this.canvas || this.activeSnapPoints.length === 0 || !this.assemblyData) {
            this.hideSnapPoints();
            return false;
        }

        var rect = this.canvas.getBoundingClientRect();
        var pickX = screenX - rect.left;
        var pickY = screenY - rect.top;

        var closestDist = 10000;
        var closestMarker = null;

        this.activeSnapPoints.forEach(marker => {
            var pos = marker.getAbsolutePosition();
            var screenPos = BABYLON.Vector3.Project(
                pos,
                BABYLON.Matrix.Identity(),
                this.scene.getTransformMatrix(),
                this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight())
            );

            var dx = screenPos.x - pickX;
            var dy = screenPos.y - pickY;
            var dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < closestDist) {
                closestDist = dist;
                closestMarker = marker;
            }
        });

        if (closestMarker && closestDist < 200) {
            var connectorId = closestMarker.metadata.connectorId;
            var parentPartId = closestMarker.metadata.parentPartId;
            var parentTypeId = closestMarker.metadata.parentTypeId;
            console.log(`ASSEMBLY SUCCESS: Snapped to ${connectorId} on ${parentPartId}`);

            // Find parent definition to get connector details
            var parentDef = this.manifest.find(m => m.Id === parentTypeId || m.id === parentTypeId);
            if (!parentDef) { console.error("Parent definition not found for: " + parentTypeId); return false; }

            var connectors = parentDef.Connectors || parentDef.connectors;
            var connDef = connectors.find(c => c.Id === connectorId || c.id === connectorId);

            if (connDef) {
                var partDef = this.manifest.find(p => p.Id === partTypeId || p.id === partTypeId);
                if (!partDef) { console.error("Part definition not found for: " + partTypeId); return false; }

                var targetPos = connDef.Position || connDef.position;

                // SMART REPLACE (Generic Core Protection)
                var existingIndex = this.assemblyData.Parts.findIndex(p => {
                    // Skip parts marked as IsCore
                    if (p.IsCore || p.isCore) return false;

                    // MUST match parent to be in the same coordinate space!
                    if ((p.ParentId || p.parentId) !== parentPartId) return false;

                    var pPos = p.Position || p.position;
                    if (!pPos) return false;

                    var d = Math.sqrt(Math.pow(pPos[0] - targetPos[0], 2) + Math.pow(pPos[1] - targetPos[1], 2) + Math.pow(pPos[2] - targetPos[2], 2));
                    return d < 0.1;
                });

                if (existingIndex !== -1) {
                    var pToRem = this.assemblyData.Parts[existingIndex];
                    console.log("Replacing existing part at slot: " + pToRem.Id);
                    this.assemblyData.Parts.splice(existingIndex, 1);
                }

                var partName = partDef.Name || partDef.name || "Part";
                var cleanId = partName.replace(/\s+/g, '') + "_" + Date.now();

                // Add to STATE (Full Enrichment from Manifest)
                var newPart = {
                    Id: cleanId,
                    TypeId: partTypeId,
                    ParentId: parentPartId,
                    Position: targetPos,
                    Rotation: connDef.Rotation || connDef.rotation || [0, 0, 0],
                    // Copy ALL visual data here so the JSON is "complete"
                    Shape: partDef.Shape || partDef.shape || "Box",
                    Category: partDef.Category || partDef.category || "Unknown",
                    IsCore: partDef.IsCore || partDef.isCore || false,
                    ColorHex: partDef.ColorHex || partDef.colorHex || "#808080",
                    Scale: partDef.Scale || partDef.scale || [1, 1, 1]
                };

                this.assemblyData.Parts.push(newPart);
                this.loadAssembly(this.assemblyData);
                this.hideSnapPoints();
                return true;
            }
        }

        this.hideSnapPoints();
        return false;
    },

    buildPartAssemblyMesh: function (partDef, scene) {
        var mesh;
        var partId = partDef.Id || partDef.id;
        var typeId = partDef.TypeId || partDef.typeId;

        // Find full manifest definition for extra metadata
        var def = this.manifest.find(m => m.Id === typeId || m.id === typeId) || partDef;

        var mat = new BABYLON.StandardMaterial(partId + "_mat", scene);
        var color = partDef.ColorHex || partDef.colorHex;
        var shape = partDef.Shape || partDef.shape || "Box";

        if (color) mat.diffuseColor = BABYLON.Color3.FromHexString(color);
        else mat.diffuseColor = new BABYLON.Color3(0.5, 0.5, 0.5);

        switch (shape) {
            case "Box":
                mesh = BABYLON.MeshBuilder.CreateBox(partId, { size: 1 }, scene);
                break;
            case "Cylinder":
                mesh = BABYLON.MeshBuilder.CreateCylinder(partId, { height: 1, diameter: 1 }, scene);
                break;
            case "Sphere":
                mesh = BABYLON.MeshBuilder.CreateSphere(partId, { diameter: 1 }, scene);
                break;
            case "Torus":
                mesh = BABYLON.MeshBuilder.CreateTorus(partId, { diameter: 1, thickness: 0.2, tessellation: 32 }, scene);
                break;
            default:
                mesh = BABYLON.MeshBuilder.CreateBox(partId, { size: 1 }, scene);
                break;
        }

        // Apply Manifest-Driven Visual Rotation (NO MORE HARDCODING!)
        var vRot = def.VisualRotation || def.visualRotation;
        if (vRot) {
            mesh.rotation.x = vRot[0] * (Math.PI / 180);
            mesh.rotation.y = vRot[1] * (Math.PI / 180);
            mesh.rotation.z = vRot[2] * (Math.PI / 180);
        }

        mesh.material = mat;
        return mesh;
    },

    init: function (canvasId, dotNetRef, vehicleJson) {
        this.dotNetRef = dotNetRef;
        this.canvas = document.getElementById(canvasId);
        this.engine = new BABYLON.Engine(this.canvas, true);
        this.scene = this.createScene(vehicleJson);

        // Resize
        window.addEventListener("resize", () => {
            this.engine.resize();
        });

        // Input Handling
        this.scene.actionManager = new BABYLON.ActionManager(this.scene);
        this.scene.actionManager.registerAction(new BABYLON.ExecuteCodeAction(BABYLON.ActionManager.OnKeyDownTrigger, (evt) => {
            var key = evt.sourceEvent.key.toLowerCase();
            this.inputMap[key] = true;
            if (key === " ") evt.sourceEvent.preventDefault(); // Stop Scrolling

            // Toggle Hero Mode (P)
            if (key === "p") {
                WastelandHero.toggleMode(this);
            }

            // Debug Spawning (Shift + 1/2)
            if (evt.sourceEvent.shiftKey) {
                var now = Date.now();
                if (this.lastSpawnTime && (now - this.lastSpawnTime < 500)) return;
                this.lastSpawnTime = now;

                var p = this.vehicle ? this.vehicle : { position: new BABYLON.Vector3(0, 0, 0), rotationQuaternion: new BABYLON.Quaternion() };

                if (key === "!" || key === "1") WastelandNPCs.spawnSpider(this.scene, p.position.x, p.position.z, this);
                if (key === "@" || key === "2") WastelandNPCs.spawnHelicopter(this.scene, p.position.x, p.position.z, this);
                if (key === "#" || key === "3") WastelandNPCs.spawnNuclearHydra(this.scene, p.position.x, p.position.z, this);
            }

            // Boss Tanker (Z)
            if (key === "z") {
                var p = this.vehicle ? this.vehicle : { position: new BABYLON.Vector3(0, 0, 0), rotationQuaternion: new BABYLON.Quaternion() };
                WastelandNPCs.createBossTanker(this.scene, p.position.x, p.position.z, this);
            }
        }));
        this.scene.actionManager.registerAction(new BABYLON.ExecuteCodeAction(BABYLON.ActionManager.OnKeyUpTrigger, (evt) => {
            var key = evt.sourceEvent.key.toLowerCase();
            this.inputMap[key] = false;
        }));

        this.engine.runRenderLoop(() => {
            this.update();
            this.scene.render();
        });
    },

    createScene: function (vehicleJson) {
        var scene = new BABYLON.Scene(this.engine);
        this.scene = scene; // [FIX] Store immediately so helper functions (getHeightAt) can accessing it during creation

        // Atmosphere: Mad Max Orange
        scene.clearColor = new BABYLON.Color3(0.8, 0.5, 0.2);
        scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
        scene.fogDensity = 0.005;
        scene.fogColor = new BABYLON.Color3(0.7, 0.5, 0.3);

        // Lights
        var sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, -0.5), scene);
        sun.diffuse = new BABYLON.Color3(1, 0.9, 0.7);
        sun.intensity = 1.5;

        var hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
        hemi.diffuse = new BABYLON.Color3(0.4, 0.2, 0.1);
        hemi.intensity = 0.6;

        // Systems
        this.initRadar(scene);
        WastelandCombat.init(scene);

        // Terrain & Props
        WastelandWorld.init(scene);
        this.ground = WastelandWorld.ground;

        // Fauna
        WastelandNPCs.createSnakes(scene, 10, this);
        WastelandNPCs.createCoyotes(scene, 5, this);

        // Vehicle
        this.createBuggy(scene, vehicleJson);

        // Camera
        // Camera
        this.camera = new BABYLON.ArcRotateCamera("MainCam", -Math.PI / 2, Math.PI / 3, 30, new BABYLON.Vector3(0, 0, 0), scene);
        this.camera.lockedTarget = this.vehicle; // Lock to car initially
        this.camera.attachControl(this.canvas, true);

        // Limits
        this.camera.lowerRadiusLimit = 5;
        this.camera.upperRadiusLimit = 60;
        this.camera.checkCollisions = true; // Don't clip underground
        this.camera.collisionRadius = new BABYLON.Vector3(0.5, 0.5, 0.5);

        return scene;
    },

    // createWasteland moved to WastelandWorld.js

    calculateHeight: function (x, z) {
        return WastelandWorld.calculateHeight(x, z);
    },

    getHeightAt: function (x, z) {
        return WastelandWorld.getHeightAt(x, z);
    },

    // O(1) Math-based height for NPCs (No Raycast)
    getHeightFast: function (x, z) {
        return WastelandWorld.calculateHeight(x, z);
    },

    // createVegetation moved to WastelandWorld.js

    createBuggy: function (scene, vehicleJson) {
        // 1. Physics Root (Invisible Driver)
        this.vehicle = BABYLON.MeshBuilder.CreateBox("carRoot", { width: 1, height: 1, depth: 1 }, scene);
        this.vehicle.isVisible = false;
        this.vehicle.position.y = 10;

        // 2. Synchronous Dummies (Predictive Logic so Update loop doesn't crash)
        this.chassis = new BABYLON.TransformNode("chassis", scene);
        this.chassis.parent = this.vehicle;

        // Dummies for weapons (Invisible cylinders)
        this.leftGun = BABYLON.MeshBuilder.CreateCylinder("lGun", { height: 1, diameter: 0.1 }, scene);
        this.leftGun.isVisible = false;
        this.leftGun.parent = this.chassis;

        this.rightGun = BABYLON.MeshBuilder.CreateCylinder("rGun", { height: 1, diameter: 0.1 }, scene);
        this.rightGun.isVisible = false;
        this.rightGun.parent = this.chassis;

        // 3. Load Visuals (JSON or GLB)
        if (vehicleJson) {
            try {
                var data = JSON.parse(vehicleJson);
                console.log("Wasteland Spawning: " + data.name);
                var builtRoot = this._buildVehicle(data, scene);
                builtRoot.parent = this.vehicle;
                this.chassis = builtRoot; // Is this enough? 

                // We need to re-assign Guns?
                // The JSON has MachineGunL/R. 
                // We could traverse and finding them to attach particles.
                // For now, let's just make the car appear.
            } catch (e) {
                console.error("Failed to spawn JSON vehicle", e);
            }
        } else {
            // Fallback to GLB
            BABYLON.SceneLoader.ImportMeshAsync("", "WastelandRaiderMax.glb", "", scene).then((result) => {
                var root = result.meshes[0];
                root.parent = this.vehicle;
                var allNodes = result.transformNodes.concat(result.meshes);
                allNodes.forEach(n => {
                    if (n.name.includes("Chassis")) this.chassis = n;
                    if (n.name.includes("GunL")) { this.leftGun.dispose(); this.leftGun = n; }
                    if (n.name.includes("GunR")) { this.rightGun.dispose(); this.rightGun = n; }
                });
                console.log("Buggy Loaded (GLB).");
            });
        }

        // 4. Particle & Stats (Re-adding them here)
        this.speed = 0;
        this.velocity = new BABYLON.Vector3(0, 0, 0);
        this.facingAngle = 0;

        this.dustSystem = new BABYLON.ParticleSystem("dust", 2000, scene);
        this.dustSystem.particleTexture = new BABYLON.Texture("https://www.babylonjs-playground.com/textures/flare.png", scene);
        this.dustSystem.emitter = this.vehicle;
        this.dustSystem.minEmitBox = new BABYLON.Vector3(-1, 0, -2);
        this.dustSystem.maxEmitBox = new BABYLON.Vector3(1, 0, -2.5);
        this.dustSystem.color1 = new BABYLON.Color4(0.8, 0.6, 0.4, 0.5);
        this.dustSystem.color2 = new BABYLON.Color4(0.8, 0.6, 0.4, 0.0);
        this.dustSystem.colorDead = new BABYLON.Color4(0, 0, 0, 0.0);
        this.dustSystem.minSize = 0.5; this.dustSystem.maxSize = 1.5;
        this.dustSystem.minLifeTime = 0.5; this.dustSystem.maxLifeTime = 1.5;
        this.dustSystem.emitRate = 0;
        this.dustSystem.blendMode = BABYLON.ParticleSystem.BLENDMODE_ONEONE;
        this.dustSystem.gravity = new BABYLON.Vector3(0, 0, 0);
        this.dustSystem.direction1 = new BABYLON.Vector3(-1, 2, -1);
        this.dustSystem.direction2 = new BABYLON.Vector3(1, 2, -1);
        this.dustSystem.minAngularSpeed = 0; this.dustSystem.maxAngularSpeed = Math.PI;
        this.dustSystem.start();
    },





    update: function () {
        if (!this.vehicle) return;

        var dt = this.engine.getDeltaTime() / 1000;
        if (dt > 0.1) dt = 0.1; // Cap lag

        // 1. Input
        var isTurbo = this.inputMap["shift"] || false;

        var baseSpeed = 100 * this.speedRatio;
        var baseAccel = 60 * this.speedRatio;

        var topSpeed = isTurbo ? baseSpeed : (baseSpeed * 0.7);

        // Update Subsystems
        this.updateRadar();
        WastelandNPCs.update(dt, this);
        WastelandCombat.update(dt, this);
        WastelandHero.update(dt, this);

        var accelRate = isTurbo ? baseAccel : (baseAccel * 0.5);
        var turnRate = isTurbo ? 2.5 : 3.5;

        var throttle = 0;
        var steer = 0;

        // Only drive if in car
        if (this.isDriving) {
            if (this.inputMap["w"]) throttle = 1;
            if (this.inputMap["s"]) throttle = -0.5;
            if (this.inputMap["a"]) steer = -1;
            if (this.inputMap["d"]) steer = 1;
        }

        // 2. Physics Model (Simple Arcade Drifter)

        // Acceleration
        if (throttle !== 0) {
            this.speed += throttle * accelRate * dt;
        } else {
            // Friction
            this.speed = BABYLON.Scalar.Lerp(this.speed, 0, 2.0 * dt);
            // [FIX] Parking Brake: Snap to 0 if very slow (prevents creeping)
            if (Math.abs(this.speed) < 0.5) {
                this.speed = 0;
                this.velocity = new BABYLON.Vector3(0, 0, 0); // Kill momentum completely
            }
        }

        // Cap Speed
        if (this.speed > topSpeed) this.speed = topSpeed;
        if (this.speed < -20) this.speed = -20;

        // Turning (Only when moving)
        if (Math.abs(this.speed) > 1) {
            var turnFactor = (Math.abs(this.speed) / topSpeed); // Turn better at speed? No, usually worse
            this.facingAngle += steer * turnRate * dt;
        }

        // Apply Rotation to Visual
        this.vehicle.rotation.y = this.facingAngle;

        // 3. Drift Logic: Velocity Vector vs Facing Vector
        // Calculate "Forward" vector based on rotation
        var forwardDir = new BABYLON.Vector3(Math.sin(this.facingAngle), 0, Math.cos(this.facingAngle));

        // Calculate "Target Velocity" (Where we WANT to go)
        var targetVel = forwardDir.scale(this.speed);

        // Lerp current real velocity to target velocity
        // High Traction = Fast Lerp
        // Low Traction (Drift) = Slow Lerp
        // Turbo = Less Traction
        var traction = 8.0;
        // Decrease traction only if turning (Drift)
        if (isTurbo && Math.abs(steer) > 0.1) traction = 1.0;

        this.velocity = BABYLON.Vector3.Lerp(this.velocity, targetVel, traction * dt);

        // 4. Move
        this.vehicle.position.addInPlace(this.velocity.scale(dt));

        // 5. Ground Clamp & Suspension
        var groundH = this.getHeightAt(this.vehicle.position.x, this.vehicle.position.z);

        var targetY = groundH + 0.5;
        if (this.vehicle.position.y > targetY) {
            // In Air: Fall slowly (Gravity equivalent)
            // [FIX] Drastically reduced gravity for "Action Movie" jumps
            var gravity = isTurbo ? 0.5 : 2.0;
            this.vehicle.position.y = BABYLON.Scalar.Lerp(this.vehicle.position.y, targetY, gravity * dt);
        } else {
            // On Ground: Snap tight (Suspension pushes up)
            this.vehicle.position.y = BABYLON.Scalar.Lerp(this.vehicle.position.y, targetY, 20.0 * dt);
        }

        // 6. Dust System logic
        if (this.dustSystem) {
            // Emit based on speed
            var speedRatio = Math.abs(this.speed) / topSpeed;
            var emitBase = speedRatio * 50; // 0-50 particles

            // Add drift dust
            // [FIX] Use normalizeToNew() to avoid destroying original velocity vector
            var driftAngle = BABYLON.Vector3.GetAngleBetweenVectors(this.velocity.normalizeToNew(), forwardDir, BABYLON.Vector3.Up());
            if (this.speed > 5 && driftAngle > 0.2) {
                emitBase += 100; // Big puff on drift
            }

            this.dustSystem.emitRate = emitBase;
        }

        // 6. Visual Tilt (Chassis Only)
        // Pitch = Terrain Slope
        var nextPos = this.vehicle.position.add(forwardDir.scale(2.0));
        var nextH = this.getHeightAt(nextPos.x, nextPos.z);
        var pitch = -Math.atan2(nextH - groundH, 2.0);

        // Roll = Centrifugal Force (Steer * Speed)
        var roll = -(steer * (this.speed / topSpeed)) * 0.4;

        // Apply to chassis
        if (this.chassis) {
            this.chassis.rotation.x = BABYLON.Scalar.Lerp(this.chassis.rotation.x, pitch, 0.1);
            this.chassis.rotation.z = BABYLON.Scalar.Lerp(this.chassis.rotation.z, roll, 0.1);
        }

        // 8. Hard Floor (Anti-Sink)
        // Allow 0.2 units of suspension compression before hard snap
        if (this.vehicle.position.y < groundH + 0.3) {
            this.vehicle.position.y = groundH + 0.5;
        }

        // 9. Fuel Consumption
        var speedBurn = Math.abs(this.speed) * 0.0002; // Very slow burn based on speed
        if (isTurbo) speedBurn *= 2.0;
        this.fuel -= speedBurn * dt; // Burn per second
        if (this.fuel < 0) this.fuel = 0;

        // 10. Scrap Collection (Simple Distance Check)
        if (WastelandWorld.scrapFields) {
            for (let i = 0; i < WastelandWorld.scrapFields.length; i++) {
                let s = WastelandWorld.scrapFields[i];
                if (s.isEnabled() && BABYLON.Vector3.Distance(this.vehicle.position, s.position) < 5) {
                    // Pick up!
                    s.setEnabled(false); // Hide
                    this.scrap += 10;
                    if (this.dotNetRef) this.dotNetRef.invokeMethodAsync("AddScrap", 10);
                }
            }
        }

        // 11. Refuel Logic
        if (WastelandWorld.gasStations && this.speed < 5) {
            for (let g of WastelandWorld.gasStations) {
                if (BABYLON.Vector3.Distance(this.vehicle.position, g.position) < 8) {
                    this.fuel += 50 * dt; // Refuel fast
                    if (this.fuel > 100) this.fuel = 100;
                }
            }
        }

        // 12. Siphon Logic (Abandoned Cars)
        if (WastelandWorld.abandonedCars && this.speed < 2) {
            for (let c of WastelandWorld.abandonedCars) {
                if (c.isEnabled() && BABYLON.Vector3.Distance(this.vehicle.position, c.position) < 6) {
                    this.fuel += 10 * dt; // Siphon slowly
                    if (this.fuel > 100) this.fuel = 100;
                    // Optional: Dim/Remove car after siphoning? For now infinite source.
                }
            }
        }

        if (WastelandWorld.ruins && WastelandWorld.ruins.length > 0) {
            // ... (Compass logic logic essentially rendered redundant by radar, but fine to keep HUD text)
        }

        // 13. Update Radar
        // (Moved to top of update loop)

        // --- COMBAT UPDATE ---
        if (this.inputMap[" "]) {
            WastelandCombat.fireMachineGun(this.scene, this);
        }
        // WastelandCombat.update handled above
        // ---------------------

        // 14. HUD Update (Always run if defined)
        if (window.updateHud) {
            // Find nearest ruin for distance signal
            var minDist = 99999;
            if (WastelandWorld.ruins) {
                for (var r of WastelandWorld.ruins) {
                    var d = BABYLON.Vector3.Distance(this.vehicle.position, r.position);
                    if (d < minDist) minDist = d;
                }
            }
            window.updateHud(Math.round(this.speed), Math.round(minDist), this.facingAngle, this.fuel, this.scrap);
        }

        this.frame = (this.frame || 0) + 1;
    },

    // createRuins moved to WastelandWorld.js
    // createScrapFields moved to WastelandWorld.js
    // createGasStations moved to WastelandWorld.js
    // createAbandonedCars moved to WastelandWorld.js

    // Fauna moved to WastelandNPCs.js

    // createSurvivorCamps moved to WastelandWorld.js
    // createBanditCamps moved to WastelandWorld.js

    initRadar: function (scene) {
        WastelandUI.init(scene);
    },

    createBlip: function (targetMesh, color, type) {
        WastelandUI.registerBlip(targetMesh, color, type);
    },

    updateRadar: function () {
        WastelandUI.update(this.vehicle, this.facingAngle);
    },

    // --- COMBAT SYSTEM ---
    // Combat handled by WastelandCombat.js

    // --- ENEMY AI SYSTEM ---
    // Enemy AI handled by WastelandCombat.js

    // Spiders, Helis, Bosses, Survivors moved to WastelandNPCs.js,

    // --- Hero Mode Logic ---

    // toggleVehicle moved to WastelandHero.js
    // updateHero moved to WastelandHero.js
};
