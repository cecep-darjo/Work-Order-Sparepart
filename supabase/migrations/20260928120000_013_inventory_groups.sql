-- Migration to add inventory_groups table and group_id column

-- Create inventory_groups table
CREATE TABLE inventory_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Add group_id column to inventory table
ALTER TABLE inventory ADD COLUMN group_id INT REFERENCES inventory_groups(id);