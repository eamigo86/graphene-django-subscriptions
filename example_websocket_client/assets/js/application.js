(function() {
    'use strict';
    var attempts = 1; 

    var createWebSocket = function() {
        var ready_states = [
            "The connection is not yet open",
            "The connection is open and ready to communicate",
            "The connection is in the process of closing",
            "The connection is closed or couldn't be opened"
        ];        
        var connection;
        var address = "";
        var connected_flag = false;
        var closed = false;
        var count = 1;        
        var output = $('#output');
        var output_btn = $('#clear_output');

        var processOutput = function(message) {
            output.append(message);
            count++;

            while (output.height() > 600 && output.children().length > 1) {
                output.children()[0].remove();
            }
        };

        var replaceNewline = function(input) {
            var newline = String.fromCharCode(13, 10);
            return input.replaceAll('\\n', newline);
        };

        var generateInterval = function(k) {
            return Math.min(30, (Math.pow(2, k) - 1)) * 1000;
        };

        var constructor = function(address) {
            connection = new WebSocket(address);

            output_btn.click(function() {
                output.children().remove();
            });

            connection.onopen = function() {
                // $("#actions_container").children().show();

                // reset the tries back to 1 since we have a new connection opened.
                attempts = 1;
                connected_flag = true;
                closed = false;

                processOutput("<p class=\"text-warning\">" + count + " - " + ready_states[connection.readyState] + " !!!</p>");               
                              
            };

            connection.onerror = function(error) {
                console.log('error')
                processOutput("<p class=\"text-error\">" + count + "- Error detected: " + ready_states[connection.readyState] + " (address: " + address + ")</p>");
            };

            connection.onmessage = function(e) {
                console.log(e)
                processOutput("<p class=\"text-success\">" + count + "- <b>RECEIVE:</b> " + e.data + "</p>");
            };

            connection.onclose = function() {
                console.log('cerrado')

                if (connected_flag === true){

                    if (closed === true){
                        processOutput("<p class=\"text-warning\">" + count + "- The connection is in the process of closing</p>");
                    }
                    else{
                        var time = generateInterval(attempts);
                        
                        processOutput("<p class=\"text-warning\">" + count + "- The connection is in the process of closing <span class=\"muted\">(reconecting after " + time + " ms)</span></p>");
        
                        setTimeout(function() {
                            // We've tried to reconnect so increment the attempts by 1
                            attempts++;
        
                            // Connection has closed so try to reconnect every x seconds.
                            constructor(address);
                        }, time);
                    }                    
                }
            };
        };

        return {
            close: function(){
                connection.close();

                closed = true;                
                address = "";
                count = 1;                

                output.children().remove();
            },
            sendMsg: function(params) {
                if (connection.readyState === 1){
                    connection.send(params);
                    processOutput("<p class=\"text-info\">" + count + "- <b>SEND:</b> " + params + "</p>");
                }
            },
            init: function(address) {
                address = address;
                constructor(address);
            }
        };
    }();
    
    $("#form_submit").click(function(e){
        e.preventDefault();

        if ($(this).hasClass( "btn-success" )){
            var secure_connexion = $("#is_secure_connection").is(':checked');
            var protocol = secure_connexion ? "wss" : "ws";

            createWebSocket.init(protocol + "://" + $("#host_input").val() + "/" + $("#route_input").val());

            $(this).removeClass( "btn-success" );
            $(this).addClass( "btn-danger" );
            $(this).text( 'Disconnect !!!' );
        }
        else{
            createWebSocket.close();
            console.log('disconect');
            $(this).addClass( "btn-success" );
            $(this).removeClass( "btn-danger" );
            $(this).text( 'Connect !!!' );                       
        }        
    }); 

})();