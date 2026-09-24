package webui

import (
	"embed"
	"io/fs"
)

//go:embed index.html app.js styles.css
var files embed.FS

func FS() fs.FS { return files }
