using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace MechScrappers.Data
{
    public class PartDef
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Description { get; set; }
        public PartType Type { get; set; }
        public string ModelPath { get; set; } // Path to GLB/GLTF relative to wwwroot
        public double Mass { get; set; }
        public int Cost { get; set; }
        public string Category { get; set; }
        public bool IsCore { get; set; }
        
        // Visual Properties
        public string Shape { get; set; }
        public double[] Scale { get; set; }
        public string ColorHex { get; set; }
        public double[] VisualRotation { get; set; } // [x, y, z]

        public List<Connector> Connectors { get; set; } = new List<Connector>();
    }

    public enum PartType
    {
        Chassis,
        Cockpit,
        Engine,
        Wheel,
        Weapon,
        Armor,
        Storage,
        Gadget
    }

    public class Connector
    {
        public string Id { get; set; }
        public double[] Position { get; set; } // [x, y, z]
        public double[] Rotation { get; set; } // [x, y, z]
        public string[] CompatibleTypes { get; set; } // List of PartTypes allowed here
    }
}
