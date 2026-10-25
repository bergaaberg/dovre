-- Who made each write (hosted Team, dovre#58): the verified email of the person whose POST it was.
-- Empty for the instance's own writes and for everything local.
ALTER TABLE actions ADD COLUMN actor TEXT;
