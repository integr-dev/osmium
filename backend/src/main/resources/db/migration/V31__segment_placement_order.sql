-- The order an agent places the blocks of one piece in: three signed axes, outermost first, with an
-- optional trailing `s` for a snaking innermost sweep. `y+z+x+` is bottom to top, north to south,
-- west to east — the order every job built before this column existed, which is why it is the
-- default for the rows that predate it.
--
-- A string rather than a set of columns because it travels: to the host on the command that
-- dispatches the piece, and back through a log where `y+z+x+s` is readable and four columns are not.
alter table build_segments
    add column placement_order varchar(8) not null default 'y+z+x+';
