Team photos live here and are picked up "as named":

  public/team/<member-name-lowercased>.png

  FE_PSYCHO  ->  public/team/fe_psycho.png
  FE_SAHIL   ->  public/team/fe_sahil.png
  FE_KANNU   ->  public/team/fe_kannu.png

The path is derived automatically from the TEAM array in js/about.js —
rename a member there and the page looks for the matching file here.
(Add an `img:` field to a member to point it at a custom path/extension.)

If a file is missing, the About page shows an initials placeholder
(e.g. "FP") in the same round frame. Square crops, 400x400 or larger,
look best.
