package main

import (
 "encoding/json"
 "os"
 "path/filepath"
 "time"

 "github.com/sagernet/sing-box/daemon"
 "github.com/sagernet/sing-box/experimental/libbox"
)

// Captured by each command handler so an old client cannot publish into a new path.
var groupEventPath string

func publishGroupEvent(path string, message libbox.OutboundGroupIterator) {
 if path == "" { return }
 groups := &daemon.Groups{}
 for message.HasNext() {
  g := message.Next()
  group := &daemon.Group{Tag:g.Tag, Type:g.Type, Selectable:g.Selectable, Selected:g.Selected, IsExpand:g.IsExpand}
  items := g.GetItems()
  for items.HasNext() {
   item := items.Next()
   group.Items = append(group.Items, &daemon.GroupItem{Tag:item.Tag, Type:item.Type, UrlTestTime:item.URLTestTime, UrlTestDelay:item.URLTestDelay})
  }
  groups.Group = append(groups.Group, group)
 }
 event := harmonySnapshot{Groups:groups, SampledAt:time.Now().UnixMilli()}
 data, err := json.Marshal(event)
 if err != nil { tailscaleDebugLog("group event encoding failed: %v", err); return }
 if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil { return }
 file, err := os.CreateTemp(filepath.Dir(path), ".groups-event-*")
 if err != nil { return }
 name := file.Name()
 defer os.Remove(name)
 if _, err = file.Write(data); err != nil { file.Close(); return }
 if err = file.Close(); err != nil { return }
 if err = os.Rename(name, path); err != nil { tailscaleDebugLog("group event publication failed: %v", err) }
}
