package output

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/olekukonko/tablewriter"
	"gopkg.in/yaml.v3"
)

type Format string

const (
	FormatTable Format = "table"
	FormatJSON  Format = "json"
	FormatYAML  Format = "yaml"
)

type Formatter struct {
	format Format
}

func NewFormatter(format string) *Formatter {
	f := Format(strings.ToLower(format))
	if f != FormatTable && f != FormatJSON && f != FormatYAML {
		f = FormatTable
	}
	return &Formatter{format: f}
}

func (f *Formatter) Format() Format {
	return f.format
}

func (f *Formatter) IsTable() bool {
	return f.format == FormatTable
}

func (f *Formatter) Output(data interface{}, tableFunc func()) error {
	switch f.format {
	case FormatJSON:
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(data)
	case FormatYAML:
		encoder := yaml.NewEncoder(os.Stdout)
		encoder.SetIndent(2)
		defer encoder.Close()
		return encoder.Encode(data)
	default:
		if tableFunc != nil {
			tableFunc()
		}
		return nil
	}
}

func Table(headers []string, rows [][]string) {
	table := tablewriter.NewWriter(os.Stdout)

	// Colorize headers if in interactive terminal
	if IsInteractive() && IsColorEnabled() {
		coloredHeaders := make([]string, len(headers))
		for i, h := range headers {
			coloredHeaders[i] = BoldCyan(h)
		}
		table.SetHeader(coloredHeaders)
	} else {
		table.SetHeader(headers)
	}

	table.SetAutoWrapText(false)
	table.SetAutoFormatHeaders(false) // Don't auto-format since we're handling colors
	table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	table.SetAlignment(tablewriter.ALIGN_LEFT)
	table.SetCenterSeparator("")
	table.SetColumnSeparator("")
	table.SetRowSeparator("")
	table.SetHeaderLine(false)
	table.SetBorder(false)
	table.SetTablePadding("  ")
	table.SetNoWhiteSpace(true)
	table.AppendBulk(rows)
	table.Render()
}

func Success(message string) {
	fmt.Println(Green("✓"), message)
}

func Error(message string) {
	fmt.Fprintln(os.Stderr, Red("✗"), message)
}

func Info(message string) {
	fmt.Println(Blue("ℹ"), message)
}

func Warn(message string) {
	fmt.Println(Yellow("⚠"), message)
}

type APIError struct {
	Status      int
	Code        string
	Message     string
	LongMessage string
}

func (e *APIError) Error() string {
	if e.LongMessage != "" {
		return fmt.Sprintf("%s: %s", e.Message, e.LongMessage)
	}
	return e.Message
}

func NewAPIError(status int, code, message, longMessage string) *APIError {
	return &APIError{Status: status, Code: code, Message: message, LongMessage: longMessage}
}

func DisplayError(err error) {
	if err == nil {
		return
	}
	if apiErr, ok := err.(*APIError); ok {
		Error(apiErr.Message)
		if apiErr.LongMessage != "" {
			fmt.Fprintf(os.Stderr, "  %s\n", Dim(apiErr.LongMessage))
		}
		return
	}
	Error(err.Error())
}
